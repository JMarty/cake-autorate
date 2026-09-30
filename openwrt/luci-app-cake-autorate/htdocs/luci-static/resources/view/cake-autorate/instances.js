'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require dom';
'require cake-autorate.api as api';

/*
 * instances.js -- configuration editor: one GridSection row per configured
 * instance, plus a global settings section (log_to_file and friends applied
 * whenever an instance does not override them). Every field is defaults-aware:
 * an empty value is not stored (rmempty) so the instance falls back to the
 * global section, then to the built-in default shown as its placeholder.
 * Defaults-backed booleans are tri-state lists (Default / On / Off, see
 * flagOpt()) so "off" can be stored even when the built-in default is on.
 *
 * Save flow: plain LuCI save/apply. The init script renders each instance's
 * config on (re)start and, when sqm_sync_base_rates is set, pushes the base
 * rates into the linked SQM queue; it does not validate the config. The
 * modal validators below catch the common cross-field mistakes
 * (min <= base <= max, connection active threshold, dl_if != ul_if) before
 * anything is saved. Anything else makes the instance exit at startup; the
 * rpcd status call then runs --check-config for that crashed instance and
 * the Overview page shows the result as a configuration error.
 */

/* UCI pinger_method values use a hyphen; system_info.pingers keys use '_'. */
var PING_KEY_MAP = { 'fping-ts': 'fping_ts' };

var PINGER_METHODS = [
	{ key: 'fping', label: _('fping — round robin pinging (RTTs)') },
	{ key: 'fping-ts', label: _('fping-ts — round robin pinging using ICMP type 13 (OWDs)') },
	{ key: 'tsping', label: _('tsping — round robin pinging using ICMP type 13 (OWDs)') },
	{ key: 'irtt', label: _('irtt — individual pinging (OWDs)') },
	{ key: 'ping', label: _('ping (iputils) — individual pinging (RTTs)') }
];

/* Section names that are not instances. */
var RESERVED = { global: true, mqtt: true };

var defaults = {};

function validInstanceName(name) {
	return /^[A-Za-z0-9_]+$/.test(name || '') && !RESERVED[name] && !uci.get('cake-autorate', name);
}

var INVALID_NAME_MSG = _('Instance names may contain only letters, digits and underscores, must be unique and cannot be "global" or "mqtt".');

/*
 * opt() -- every instance/global option goes through this so defaults
 * metadata (placeholder + description) is applied uniformly. modalonly
 * defaults to true; grid columns pass modalonly:null in `extra` (shown in
 * the grid AND in the edit modal -- modalonly:false would drop the field
 * from the modal).
 */
function opt(s, tab, widget, name, title, extra) {
	var o = tab ? s.taboption(tab, widget, name, title) : s.option(widget, name, title);
	var d = defaults[name];
	if (d && d.description) o.description = d.description;
	if (d && !d.list && widget === form.Value) {
		o.placeholder = d.value;
		/* Grid cells: an unset option runs on the built-in default, so show
		 * that (greyed) instead of LuCI's generic "none". */
		o.textvalue = function(section_id) {
			var v = this.cfgvalue(section_id);
			if (v != null && v !== '')
				return widget.prototype.textvalue.apply(this, arguments);
			return E('span', { 'style': 'opacity:.6', 'title': _('built-in default') }, String(this.placeholder));
		};
	}
	o.rmempty = true;
	o.modalonly = true;
	if (extra) Object.assign(o, extra);
	return o;
}

/* Tri-state for defaults-backed booleans: '' = inherit (global section, else
 * built-in default), '1' = on, '0' = off. A form.Flag cannot express "off"
 * when the built-in default is on (its unchecked value equals its default
 * and is removed on save), so every such option uses this instead. */
function flagOpt(s, tab, name, title) {
	var d = defaults[name];
	var o = opt(s, tab, form.ListValue, name, title);
	/* Without backend metadata the built-in default is unknown. */
	var dfltLabel = d ? _('Default (%s)').format(String(d.value) === '1' ? _('on') : _('off')) : _('Default');
	o.optional = true;
	o.value('', dfltLabel);
	o.value('1', _('On'));
	o.value('0', _('Off'));
	o.textvalue = function(section_id) {
		var v = this.cfgvalue(section_id);
		return v === '1' ? _('On') : v === '0' ? _('Off') : E('span', { 'style': 'opacity:.6' }, dfltLabel);
	};
	return o;
}

/* Raw effective value of `key` for the section being edited: the field's own
 * pending value, a sibling field's form value (the stored section value if
 * that widget is not rendered), the global section, then the built-in
 * default. `opt` is the option whose validate() is running. */
function effectiveRaw(opt, section_id, key, ownKey, ownValue) {
	var v = (key === ownKey) ? ownValue : opt.section.formvalue(section_id, key);
	if (v == null) v = uci.get('cake-autorate', section_id, key);
	if (v == null || v === '') v = uci.get('cake-autorate', 'global', key);
	if (v == null || v === '') v = (defaults[key] || {}).value;
	return v;
}

function effectiveValue(opt, section_id, key, ownKey, ownValue) {
	return parseFloat(effectiveRaw(opt, section_id, key, ownKey, ownValue));
}

function ratesValidate(dir, ownKey) {
	return function(section_id, value) {
		var lo = effectiveValue(this, section_id, 'min_' + dir + '_shaper_rate_kbps', ownKey, value),
		    mid = effectiveValue(this, section_id, 'base_' + dir + '_shaper_rate_kbps', ownKey, value),
		    hi = effectiveValue(this, section_id, 'max_' + dir + '_shaper_rate_kbps', ownKey, value),
		    act = effectiveValue(this, section_id, 'connection_active_thr_kbps', ownKey, value);
		if (isNaN(lo) || isNaN(mid) || isNaN(hi)) return true;
		if (lo < 1) return _('Minimum rate must be at least 1 kbit/s');
		if (!(lo <= mid && mid <= hi)) return _('Rates must satisfy min ≤ base ≤ max');
		/* Threshold vs. min is reported on the min field only (base/max are
		 * not the field to fix); connection_active_thr_kbps checks it too. */
		if (ownKey === 'min_' + dir + '_shaper_rate_kbps' && !isNaN(act) && act > lo) return _('Must not be below the connection active threshold (%d kbit/s)').format(act);
		return true;
	};
}

function activeThrValidate(section_id, value) {
	var act = effectiveValue(this, section_id, 'connection_active_thr_kbps', 'connection_active_thr_kbps', value),
	    minDl = effectiveValue(this, section_id, 'min_dl_shaper_rate_kbps', 'connection_active_thr_kbps', value),
	    minUl = effectiveValue(this, section_id, 'min_ul_shaper_rate_kbps', 'connection_active_thr_kbps', value);
	if (isNaN(act)) return true;
	if (!isNaN(minDl) && act > minDl)
		return _('Must not exceed the minimum download rate (%d kbit/s)').format(minDl);
	if (!isNaN(minUl) && act > minUl)
		return _('Must not exceed the minimum upload rate (%d kbit/s)').format(minUl);
	return true;
}

/* Interface fields: unique across instances and dl_if != ul_if. Compares
 * effective values (instance -> global -> built-in default), so two instances
 * that both inherit the same interface are caught too. */
function ifValidate(ownKey, otherKey) {
	return function(section_id, value) {
		var own = effectiveRaw(this, section_id, ownKey, ownKey, value);
		if (!own) return true;
		var others = uci.sections('cake-autorate', 'instance');
		for (var i = 0; i < others.length; i++) {
			if (others[i]['.name'] === section_id) continue;
			var theirs = others[i][ownKey];
			if (theirs == null || theirs === '') theirs = uci.get('cake-autorate', 'global', ownKey);
			if (theirs == null || theirs === '') theirs = (defaults[ownKey] || {}).value;
			if (theirs === own)
				return _('Interface already used by instance %s').format(others[i]['.name']);
		}
		if (own === effectiveRaw(this, section_id, otherKey, ownKey, value))
			return _('Download and upload interface must differ');
		return true;
	};
}

/* Cross-field validators only run for the field being edited; re-run the
 * related fields' validation on change so a fixed pair clears both errors. */
function revalidate(keys) {
	return function(ev, section_id) {
		for (var i = 0; i < keys.length; i++) {
			var el = this.section.getUIElement(section_id, keys[i]);
			if (el && typeof el.triggerValidation === 'function')
				el.triggerValidation();
		}
	};
}

var RATE_KEYS = [
	'min_dl_shaper_rate_kbps', 'base_dl_shaper_rate_kbps', 'max_dl_shaper_rate_kbps',
	'min_ul_shaper_rate_kbps', 'base_ul_shaper_rate_kbps', 'max_ul_shaper_rate_kbps',
	'connection_active_thr_kbps'
];

return view.extend({
	load: function() {
		var self = this;
		return Promise.all([
			uci.load('cake-autorate'),
			api.getDefaults(),
			api.getSystemInfo()
		]).then(function(data) {
			self.defaults = (data[1] && data[1].defaults) || {};
			self.sysinfo = data[2] || {};
			defaults = self.defaults;
			return data;
		});
	},

	/* "Create SQM instance…" dialog; the page reloads on success so the new
	 * queue shows up in the "Linked SQM instance" list. */
	showCreateSqm: function() {
		var dlDefault = (this.defaults.base_dl_shaper_rate_kbps || {}).value || 20000;
		var ulDefault = (this.defaults.base_ul_shaper_rate_kbps || {}).value || 10000;

		var ifaceInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': '' });
		var dlInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': String(dlDefault) });
		var ulInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': String(ulDefault) });

		ui.showModal(_('Create SQM instance'), [
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Interface')),
				E('div', { 'class': 'cbi-value-field' }, ifaceInput)
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Download (kbps)')),
				E('div', { 'class': 'cbi-value-field' }, dlInput)
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Upload (kbps)')),
				E('div', { 'class': 'cbi-value-field' }, ulInput)
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-positive',
					'click': function() {
						return api.sqmCreate(ifaceInput.value, parseInt(dlInput.value, 10) || 0, parseInt(ulInput.value, 10) || 0)
							.then(function(res) {
								ui.hideModal();
								if (res && res.ok) {
									ui.addNotification(null, E('p', {}, _('SQM instance created.')), 'info');
									location.reload();
								} else {
									ui.addNotification(null, E('p', {}, [ (res && res.error) || _('Failed to create SQM instance.') ]), 'error');
								}
							});
					}
				}, _('Create'))
			])
		]);
	},

	/* Clone dialog: copies every option except the per-WAN ones (enabled,
	 * interfaces, linked SQM queue); the copy is created disabled. */
	showClone: function(map, sid) {
		var nameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': sid + '_2' });
		/* Errors are shown inside the dialog: a page notification would be
		 * hidden behind the modal overlay. */
		var errorEl = E('div', { 'class': 'alert-message error', 'style': 'display:none' });

		ui.showModal(_('Clone instance "%s"').format(sid), [
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Name of the copy')),
				E('div', { 'class': 'cbi-value-field' }, [
					nameInput,
					E('div', { 'class': 'cbi-value-description' }, _('Letters, digits and underscores only.'))
				])
			]),
			errorEl,
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-positive',
					'click': function() {
						var newId = nameInput.value;
						if (!validInstanceName(newId)) {
							errorEl.textContent = INVALID_NAME_MSG;
							errorEl.style.display = '';
							return;
						}
						var SKIP = { enabled: true, dl_if: true, ul_if: true, sqm_instance: true };
						var src = uci.get('cake-autorate', sid) || {};
						uci.add('cake-autorate', 'instance', newId);
						for (var k in src)
							if (k.charAt(0) !== '.' && !SKIP[k])
								uci.set('cake-autorate', newId, k, src[k]);
						uci.set('cake-autorate', newId, 'enabled', '0');
						ui.hideModal();
						return map.save(null, true).then(function() {
							ui.addNotification(null, E('p', {}, [ _('Copy "%s" created disabled. Set its interfaces, then enable it.').format(newId) ]), 'info');
						});
					}
				}, _('Clone'))
			])
		]);
		nameInput.focus();
	},

	render: function() {
		var self = this;
		var sysinfo = this.sysinfo || {};

		var m = new form.Map('cake-autorate', _('CAKE Autorate — Instances'),
			_('One instance per shaped WAN. Values left empty use the global setting, else the built-in default shown as placeholder. Changes restart only the edited instance.'));

		/* ── Global settings ─────────────────────────────────────── */
		var gs = m.section(form.NamedSection, 'global', 'global', _('Global settings'),
			_('Applied to every instance unless overridden per instance.'));
		gs.addremove = false;

		/* opt() branches to s.option(...) when tab is null/falsy -- LuCI's
		 * AbstractSection.taboption() throws ReferenceError for an
		 * unregistered tab, so a bare taboption(null, ...) call on this
		 * untabbed NamedSection would crash the whole page. */
		flagOpt(gs, null, 'log_to_file', _('Log to file'));
		opt(gs, null, form.Value, 'log_file_max_time_mins', _('Log file max time (mins)'), { datatype: 'uinteger' });
		opt(gs, null, form.Value, 'log_file_max_size_KB', _('Log file max size (KB)'), { datatype: 'uinteger' });

		/* ── Instances grid ───────────────────────────────────────── */
		var s = m.section(form.GridSection, 'instance', _('Instances'));
		s.addremove = true;
		s.anonymous = false;
		s.nodescriptions = true;
		s.addbtntitle = _('Add instance…');
		s.modaltitle = function(sid) { return _('Instance » %s').format(sid); };

		s.handleAdd = function(ev, name) {
			if (!validInstanceName(name)) {
				ui.addNotification(null, E('p', {}, INVALID_NAME_MSG), 'error');
				return Promise.resolve();
			}
			return form.GridSection.prototype.handleAdd.apply(this, [ ev, name ]);
		};

		s.tab('general', _('General'));
		s.tab('pinger', _('Pinger'));
		s.tab('thresholds', _('Thresholds'));
		s.tab('health', _('Reflector health'));
		s.tab('sleep', _('Sleep / stall'));
		s.tab('logging', _('Logging'));

		/* Clone row action, appended next to the built-in Edit/Delete. */
		s.renderRowActions = function(section_id) {
			var tdEl = this.super('renderRowActions', [ section_id, _('Edit') ]);
			dom.append(tdEl.lastChild, E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': ui.createHandlerFn(this, function(sid) {
					self.showClone(this.map, sid);
				}, section_id)
			}, _('Clone')));
			return tdEl;
		};

		/* ══════════════════════════════ general ══════════════════════════════ */

		opt(s, 'general', form.Flag, 'enabled', _('Enabled'), { default: '0', rmempty: false, editable: true, modalonly: null });

		if (sysinfo.sqm_installed) {
			var oSqm = opt(s, 'general', form.ListValue, 'sqm_instance', _('Linked SQM instance'));
			oSqm.optional = true;
			oSqm.value('', _('— not linked —'));
			(sysinfo.sqm || []).forEach(function(q) {
				oSqm.value(q.id, _('%s (%s)').format(q.id, q.interface));
			});
			oSqm.onchange = function(ev, section_id, value) {
				var q = null, list = sysinfo.sqm || [];
				for (var i = 0; i < list.length; i++)
					if (list[i].id === value) { q = list[i]; break; }
				if (!q) return;
				var dlInput = this.section.getUIElement(section_id, 'dl_if');
				var ulInput = this.section.getUIElement(section_id, 'ul_if');
				if (dlInput) dlInput.setValue(q.ifb);
				if (ulInput) ulInput.setValue(q.interface);
			};
		} else {
			var oSqmMissing = s.taboption('general', form.DummyValue, '_sqm_missing', _('Linked SQM instance'),
				_('sqm-scripts is not installed.'));
			oSqmMissing.modalonly = true;
			oSqmMissing.rmempty = true;
		}

		var oDlIf = opt(s, 'general', form.Value, 'dl_if', _('Download interface'), {
			datatype: 'maxlength(15)',
			description: _("download side interface, usually SQM's ifb4<wan>"),
			modalonly: null,
			validate: ifValidate('dl_if', 'ul_if')
		});
		oDlIf.onchange = revalidate([ 'ul_if' ]);

		var oUlIf = opt(s, 'general', form.Value, 'ul_if', _('Upload interface'), {
			datatype: 'maxlength(15)',
			modalonly: null,
			validate: ifValidate('ul_if', 'dl_if')
		});
		oUlIf.onchange = revalidate([ 'dl_if' ]);

		flagOpt(s, 'general', 'adjust_dl_shaper_rate', _('Adjust download shaper rate'));
		flagOpt(s, 'general', 'adjust_ul_shaper_rate', _('Adjust upload shaper rate'));

		function rateOpt(key, title, dir, grid) {
			var o = opt(s, 'general', form.Value, key, title, { datatype: 'uinteger', validate: ratesValidate(dir, key) });
			if (grid) o.modalonly = null;
			o.onchange = revalidate(RATE_KEYS);
			return o;
		}

		rateOpt('min_dl_shaper_rate_kbps', _('Min download shaper rate (kbps)'), 'dl', false);
		rateOpt('base_dl_shaper_rate_kbps', _('Base download shaper rate (kbps)'), 'dl', true);
		rateOpt('max_dl_shaper_rate_kbps', _('Max download shaper rate (kbps)'), 'dl', false);

		rateOpt('min_ul_shaper_rate_kbps', _('Min upload shaper rate (kbps)'), 'ul', false);
		rateOpt('base_ul_shaper_rate_kbps', _('Base upload shaper rate (kbps)'), 'ul', true);
		rateOpt('max_ul_shaper_rate_kbps', _('Max upload shaper rate (kbps)'), 'ul', false);

		var oAct = opt(s, 'general', form.Value, 'connection_active_thr_kbps', _('Connection active threshold (kbps)'),
			{ datatype: 'uinteger', validate: activeThrValidate });
		oAct.onchange = revalidate(RATE_KEYS);

		opt(s, 'general', form.Flag, 'sqm_sync_base_rates', _('Sync SQM base rates'),
			{ description: _('Set the linked SQM instance download/upload to the base rates whenever this instance is (re)started') });

		/* ══════════════════════════════ pinger ══════════════════════════════ */

		var oMethod = opt(s, 'pinger', form.ListValue, 'pinger_method', _('Pinger method'));
		oMethod.optional = true;
		oMethod.value('', _('Default (%s)').format((defaults.pinger_method || {}).value || 'fping'));
		PINGER_METHODS.forEach(function(m2) {
			var key = PING_KEY_MAP[m2.key] || m2.key;
			var label = m2.label;
			if (sysinfo.pingers && sysinfo.pingers[key] === false)
				label = _('%s (not installed)').format(label);
			oMethod.value(m2.key, label);
		});

		opt(s, 'pinger', form.Value, 'no_pingers', _('Number of pingers'), { datatype: 'uinteger' });
		opt(s, 'pinger', form.Value, 'reflector_ping_interval_s', _('Reflector ping interval (s)'), { datatype: 'ufloat' });
		opt(s, 'pinger', form.DynamicList, 'reflectors', _('Reflectors'), { datatype: 'host' });
		opt(s, 'pinger', form.Value, 'reflectors_url', _('Reflectors URL'));
		opt(s, 'pinger', form.Value, 'reflectors_url_skip_lines', _('Reflectors URL: lines to skip'), { datatype: 'uinteger' });
		flagOpt(s, 'pinger', 'randomize_reflectors', _('Randomize reflectors'));
		flagOpt(s, 'pinger', 'retain_reflector_stats', _('Retain reflector stats'));
		opt(s, 'pinger', form.Value, 'irtt_session_duration_m', _('irtt session duration (mins)'),
			{ datatype: 'uinteger', depends: { pinger_method: 'irtt' } });

		/* probe_routing: UI-only synthetic option derived from ping_prefix_string
		 * / ping_extra_args. write()/remove() are no-ops; onchange pushes the
		 * chosen value into the real fields in the open modal. ping_prefix_string
		 * and ping_extra_args stay always-visible (no depends) -- an option whose
		 * depends is unsatisfied at parse time is inactive and gets stripped from
		 * UCI on save, which would silently delete an existing mwan3/custom prefix
		 * whenever the modal was reopened and saved with routing set to something
		 * else. */
		var oProbe = s.taboption('pinger', form.ListValue, 'probe_routing', _('Probe routing'),
			_('How ping probes are routed out through this WAN. Required for correct latency measurement on multi-WAN setups.'));
		oProbe.modalonly = true;
		oProbe.rmempty = true;
		oProbe.write = function() {};
		oProbe.remove = function() {};
		oProbe.value('none', _('none (single WAN)'));
		if (sysinfo.mwan3_installed) {
			(sysinfo.mwan3 || []).forEach(function(w) {
				oProbe.value('mwan3:' + w.name, _('mwan3: %s (%s)').format(w.name, w.device));
			});
		}
		oProbe.value('custom', _('custom'));
		oProbe.cfgvalue = function(section_id) {
			var prefix = uci.get('cake-autorate', section_id, 'ping_prefix_string') || '';
			var extra = uci.get('cake-autorate', section_id, 'ping_extra_args') || '';
			var mwanMatch = /^mwan3 use (.+) exec$/.exec(prefix);
			if (mwanMatch)
				return 'mwan3:' + mwanMatch[1];
			if (extra || prefix)
				return 'custom';
			return 'none';
		};
		oProbe.onchange = function(ev, section_id, value) {
			var prefixInput = this.section.getUIElement(section_id, 'ping_prefix_string');
			var extraInput = this.section.getUIElement(section_id, 'ping_extra_args');
			if (value === 'none') {
				/* Clear both fields -- 'none' means no routing prefix/args apply. */
				if (prefixInput) prefixInput.setValue('');
				if (extraInput) extraInput.setValue('');
			} else if (value.indexOf('mwan3:') === 0) {
				if (prefixInput) prefixInput.setValue('mwan3 use ' + value.substring(6) + ' exec');
			}
			/* 'custom' touches neither field -- the user's existing values stand. */
			if (prefixInput && typeof prefixInput.triggerValidation === 'function')
				prefixInput.triggerValidation();
			if (extraInput && typeof extraInput.triggerValidation === 'function')
				extraInput.triggerValidation();
		};

		opt(s, 'pinger', form.Value, 'ping_prefix_string', _('Ping prefix string'), {
			description: _('e.g. "mwan3 use <iface> exec" works with fping/ping; irtt/tsping need ping_extra_args or fwmark-based routing instead.')
		});
		opt(s, 'pinger', form.Value, 'ping_extra_args', _('Ping extra args'));

		/* ══════════════════════════════ thresholds ══════════════════════════════ */

		opt(s, 'thresholds', form.Value, 'dl_owd_delta_delay_thr_ms', _('DL OWD delta delay threshold (ms)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'ul_owd_delta_delay_thr_ms', _('UL OWD delta delay threshold (ms)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'dl_avg_owd_delta_max_adjust_up_thr_ms', _('DL avg OWD delta max adjust-up threshold (ms)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'ul_avg_owd_delta_max_adjust_up_thr_ms', _('UL avg OWD delta max adjust-up threshold (ms)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'dl_avg_owd_delta_max_adjust_down_thr_ms', _('DL avg OWD delta max adjust-down threshold (ms)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'ul_avg_owd_delta_max_adjust_down_thr_ms', _('UL avg OWD delta max adjust-down threshold (ms)'), { datatype: 'ufloat' });

		opt(s, 'thresholds', form.Value, 'alpha_baseline_increase', _('Baseline EWMA alpha (increase)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'alpha_baseline_decrease', _('Baseline EWMA alpha (decrease)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'alpha_delta_ewma', _('Delta EWMA alpha'), { datatype: 'ufloat' });

		opt(s, 'thresholds', form.Value, 'shaper_rate_min_adjust_down_bufferbloat', _('Shaper rate min adjust-down factor (bufferbloat)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'shaper_rate_max_adjust_down_bufferbloat', _('Shaper rate max adjust-down factor (bufferbloat)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'shaper_rate_min_adjust_up_load_high', _('Shaper rate min adjust-up factor (high load)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'shaper_rate_max_adjust_up_load_high', _('Shaper rate max adjust-up factor (high load)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'shaper_rate_adjust_down_load_low', _('Shaper rate adjust-down factor (low load)'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'shaper_rate_adjust_up_load_low', _('Shaper rate adjust-up factor (low load)'), { datatype: 'ufloat' });

		opt(s, 'thresholds', form.Value, 'bufferbloat_detection_window', _('Bufferbloat detection window'), { datatype: 'uinteger' });
		opt(s, 'thresholds', form.Value, 'bufferbloat_detection_thr', _('Bufferbloat detection threshold'), { datatype: 'uinteger' });
		opt(s, 'thresholds', form.Value, 'high_load_thr', _('High load threshold'), { datatype: 'ufloat' });
		opt(s, 'thresholds', form.Value, 'bufferbloat_refractory_period_ms', _('Bufferbloat refractory period (ms)'), { datatype: 'uinteger' });
		opt(s, 'thresholds', form.Value, 'decay_refractory_period_ms', _('Decay refractory period (ms)'), { datatype: 'uinteger' });

		/* ══════════════════════════════ health ══════════════════════════════ */

		opt(s, 'health', form.Value, 'reflector_health_check_interval_s', _('Reflector health check interval (s)'), { datatype: 'ufloat' });
		opt(s, 'health', form.Value, 'reflector_response_deadline_s', _('Reflector response deadline (s)'), { datatype: 'ufloat' });
		opt(s, 'health', form.Value, 'reflector_misbehaving_detection_window', _('Reflector misbehaving detection window'), { datatype: 'uinteger' });
		opt(s, 'health', form.Value, 'reflector_misbehaving_detection_thr', _('Reflector misbehaving detection threshold'), { datatype: 'uinteger' });
		opt(s, 'health', form.Value, 'reflector_replacement_interval_mins', _('Reflector replacement interval (mins)'), { datatype: 'uinteger' });
		opt(s, 'health', form.Value, 'reflector_comparison_interval_mins', _('Reflector comparison interval (mins)'), { datatype: 'uinteger' });
		opt(s, 'health', form.Value, 'reflector_sum_owd_baselines_delta_thr_ms', _('Reflector sum OWD baselines delta threshold (ms)'), { datatype: 'ufloat' });
		opt(s, 'health', form.Value, 'reflector_owd_delta_ewma_delta_thr_ms', _('Reflector OWD delta EWMA delta threshold (ms)'), { datatype: 'ufloat' });

		/* ══════════════════════════════ sleep ══════════════════════════════ */

		flagOpt(s, 'sleep', 'enable_sleep_function', _('Enable sleep function'));
		opt(s, 'sleep', form.Value, 'sustained_idle_sleep_thr_s', _('Sustained idle sleep threshold (s)'), { datatype: 'ufloat' });
		flagOpt(s, 'sleep', 'min_shaper_rates_enforcement', _('Enforce minimum shaper rates'));
		flagOpt(s, 'sleep', 'reset_shaper_rates_on_exit', _('Reset CAKE to base rates on stop'));
		opt(s, 'sleep', form.Value, 'stall_detection_thr', _('Stall detection threshold'), { datatype: 'uinteger' });
		opt(s, 'sleep', form.Value, 'connection_stall_thr_kbps', _('Connection stall threshold (kbps)'), { datatype: 'uinteger' });
		opt(s, 'sleep', form.Value, 'global_ping_response_timeout_s', _('Global ping response timeout (s)'), { datatype: 'ufloat' });
		opt(s, 'sleep', form.Value, 'startup_wait_s', _('Startup wait (s)'), { datatype: 'ufloat' });
		opt(s, 'sleep', form.Value, 'if_up_check_interval_s', _('Interface up check interval (s)'), { datatype: 'ufloat' });
		opt(s, 'sleep', form.Value, 'monitor_achieved_rates_interval_ms', _('Monitor achieved rates interval (ms)'), { datatype: 'uinteger' });
		opt(s, 'sleep', form.Value, 'monitor_cpu_usage_interval_ms', _('Monitor CPU usage interval (ms)'), { datatype: 'uinteger' });

		/* ══════════════════════════════ logging ══════════════════════════════ */

		flagOpt(s, 'logging', 'output_processing_stats', _('Output processing stats'));
		flagOpt(s, 'logging', 'output_load_stats', _('Output load stats'));
		flagOpt(s, 'logging', 'output_reflector_stats', _('Output reflector stats'));
		flagOpt(s, 'logging', 'output_summary_stats', _('Output summary stats'));
		flagOpt(s, 'logging', 'output_cake_changes', _('Output CAKE changes'));
		flagOpt(s, 'logging', 'output_cpu_stats', _('Output CPU stats'));
		flagOpt(s, 'logging', 'output_cpu_raw_stats', _('Output raw CPU stats'));
		flagOpt(s, 'logging', 'debug', _('Debug'));
		flagOpt(s, 'logging', 'log_DEBUG_messages_to_syslog', _('Log DEBUG messages to syslog'));
		flagOpt(s, 'logging', 'log_to_file', _('Log to file'));
		flagOpt(s, 'logging', 'log_file_export_compress', _('Compress exported log file'));

		opt(s, 'logging', form.Value, 'log_file_max_time_mins', _('Log file max time (mins)'), { datatype: 'uinteger' });
		opt(s, 'logging', form.Value, 'log_file_max_size_KB', _('Log file max size (KB)'), { datatype: 'uinteger' });
		opt(s, 'logging', form.Value, 'log_file_buffer_timeout_ms', _('Log file buffer timeout (ms)'), { datatype: 'uinteger' });
		opt(s, 'logging', form.Value, 'status_file_interval_ms', _('Status file interval (ms)'), { datatype: 'uinteger' });
		opt(s, 'logging', form.Value, 'log_file_path_override', _('Log file path override'));

		/* ── Above the map: backend warning + SQM creation ─────────── */
		var top = [];

		/* No defaults at all: pre-owrt3 backend. Defaults without
		 * reset_shaper_rates_on_exit: owrt3 (3.5.0-r2) backend, which lacks
		 * that option, service_control and the other r3 features. */
		if (Object.keys(defaults).length === 0 || !defaults.reset_shaper_rates_on_exit)
			top.push(E('div', { 'class': 'alert-message warning' },
				E('p', {}, _('The installed cake-autorate backend is older than this web interface: some settings, field defaults, help texts or buttons may be missing or not work. Please update the cake-autorate package.'))));

		if (sysinfo.sqm_installed)
			top.push(E('div', { 'class': 'cbi-section' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, function() {
						/* Stage pending form edits first -- the dialog reloads
						 * the page on success. */
						return m.save().then(function() {
							self.showCreateSqm();
						});
					})
				}, _('Create SQM instance…'))
			]));

		return m.render().then(function(el) {
			return E([], top.concat([ el ]));
		});
	}
});
