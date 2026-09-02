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
 * built-in default shown as its placeholder.
 *
 * Save flow (see handleSaveApply below): handleSave() writes staged UCI,
 * ui.changes.apply() commits + reloads init scripts, and only then do we
 * run api.checkConfig() per instance against the now-committed config. A
 * checkConfig failure is reported as a prominent notification but is NOT
 * rolled back -- the user's data stays in UCI and they fix + re-apply.
 * sqm_sync_base_rates jobs run only after a clean check.
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

var defaults = {};

/*
 * opt() -- every instance/global option goes through this so defaults
 * metadata (placeholder + description) is applied uniformly. modalonly
 * defaults to true; callers that need a grid column pass modalonly:false
 * in `extra`.
 */
function opt(s, tab, widget, name, title, extra) {
	var o = tab ? s.taboption(tab, widget, name, title) : s.option(widget, name, title);
	var d = defaults[name];
	if (d && !d.list) {
		o.placeholder = d.value;
		if (d.description) o.description = d.description;
	}
	o.rmempty = true;
	o.modalonly = true;
	if (extra) Object.assign(o, extra);
	return o;
}

return view.extend({
	load: function() {
		var self = this;
		return Promise.all([
			uci.load('cake-autorate'),
			api.getDefaults(),
			api.getSystemInfo()
		]).then(function(data) {
			self.defaults = data[1].defaults || {};
			self.sysinfo = data[2] || {};
			defaults = self.defaults;
			return data;
		});
	},

	/* handleSaveApply -- see file header for the ruling this implements. */
	handleSaveApply: function(ev, mode) {
		var self = this;
		return this.handleSave(ev).then(function() {
			return ui.changes.apply(mode == '0');
		}).then(function() {
			var ids = uci.sections('cake-autorate', 'instance').map(function(s2) { return s2['.name']; });
			return Promise.all(ids.map(function(id) { return api.checkConfig(id); })).then(function(results) {
				var bad = [];
				for (var i = 0; i < results.length; i++)
					if (results[i] && results[i].ok && results[i].valid === false)
						bad.push(ids[i] + ': ' + (results[i].errors || []).join('; '));

				if (bad.length) {
					ui.addNotification(null, E('p', {}, [
						E('strong', {}, _('Configuration rejected by cake-autorate:')),
						E('br'),
						bad.join(' ')
					]), 'error');
					return null;
				}

				/* sqm_sync_base_rates: push base rates into the linked SQM queue. */
				var jobs = [];
				uci.sections('cake-autorate', 'instance').forEach(function(s2) {
					if (s2.sqm_sync_base_rates == '1' && s2.sqm_instance)
						jobs.push(api.sqmSyncRates(s2.sqm_instance,
							parseInt(s2.base_dl_shaper_rate_kbps || (self.defaults.base_dl_shaper_rate_kbps || {}).value || 0, 10),
							parseInt(s2.base_ul_shaper_rate_kbps || (self.defaults.base_ul_shaper_rate_kbps || {}).value || 0, 10)));
				});
				return Promise.all(jobs);
			});
		});
	},

	render: function() {
		var self = this;
		var sysinfo = this.sysinfo || {};

		var m = new form.Map('cake-autorate', _('CAKE Autorate — Instances'),
			_('One instance per shaped WAN. Values left empty use the built-in default shown as placeholder. Changes restart only the edited instance.'));

		/* ── Global settings ─────────────────────────────────────── */
		var gs = m.section(form.NamedSection, 'global', 'global', _('Global settings'),
			_('Applied to every instance unless overridden per instance.'));
		gs.addremove = false;

		opt(gs, null, form.Flag, 'log_to_file', _('Log to file'), { modalonly: false });
		opt(gs, null, form.Value, 'log_file_max_time_mins', _('Log file max time (mins)'), { datatype: 'uinteger', modalonly: false });
		opt(gs, null, form.Value, 'log_file_max_size_KB', _('Log file max size (KB)'), { datatype: 'uinteger', modalonly: false });
		/* opt() branches to s.option(...) when tab is null/falsy -- LuCI's
		 * AbstractSection.taboption() throws ReferenceError for an
		 * unregistered tab, so a bare taboption(null, ...) call on this
		 * untabbed NamedSection would crash the whole page. */

		/* ── Instances grid ───────────────────────────────────────── */
		var s = m.section(form.GridSection, 'instance', _('Instances'));
		s.addremove = true;
		s.anonymous = false;
		s.nodescriptions = true;
		s.addbtntitle = _('Add instance…');
		s.modaltitle = function(sid) { return _('Instance') + ' » ' + sid; };

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
					var newId = window.prompt(_('Name of the copy (letters, digits, underscore):'), sid + '_2');
					if (newId == null) return;
					if (!/^[A-Za-z0-9_]+$/.test(newId) || uci.get('cake-autorate', newId)) {
						ui.addNotification(null, E('p', {}, _('Invalid or already existing instance name.')), 'error');
						return;
					}
					uci.add('cake-autorate', 'instance', newId);
					var src = uci.get_all('cake-autorate', sid);
					for (var k in src)
						if (k.charAt(0) !== '.')
							uci.set('cake-autorate', newId, k, src[k]);
					return this.map.save(null, true);
				}, section_id)
			}, _('Clone')));
			return tdEl;
		};

		/* ══════════════════════════════ general ══════════════════════════════ */

		opt(s, 'general', form.Flag, 'enabled', _('Enabled'), { default: '0', rmempty: false, editable: true, modalonly: false });

		if (sysinfo.sqm_installed) {
			var oSqm = opt(s, 'general', form.ListValue, 'sqm_instance', _('Linked SQM instance'),
				{ modalonly: true });
			oSqm.value('', _('— not linked —'));
			(sysinfo.sqm || []).forEach(function(q) {
				oSqm.value(q.id, q.id + ' (' + q.interface + ')');
			});
			oSqm.onchange = function(ev, section_id, value) {
				var q = null, list = sysinfo.sqm || [];
				for (var i = 0; i < list.length; i++)
					if (list[i].id === value) { q = list[i]; break; }
				if (!q) return;
				var dlIf = this.map.lookupOption('dl_if', section_id);
				var ulIf = this.map.lookupOption('ul_if', section_id);
				if (dlIf && dlIf[0]) {
					var dlInput = dlIf[0].getUIElement(section_id);
					if (dlInput) dlInput.setValue(q.ifb);
				}
				if (ulIf && ulIf[0]) {
					var ulInput = ulIf[0].getUIElement(section_id);
					if (ulInput) ulInput.setValue(q.interface);
				}
			};
		} else {
			var oSqmMissing = s.taboption('general', form.DummyValue, '_sqm_missing', _('Linked SQM instance'),
				_('sqm-scripts is not installed.'));
			oSqmMissing.modalonly = true;
			oSqmMissing.rmempty = true;
		}

		var oCreateSqm = s.taboption('general', form.Button, '_create_sqm', _('Create SQM instance…'));
		oCreateSqm.modalonly = true;
		oCreateSqm.inputstyle = 'apply';
		oCreateSqm.inputtitle = _('Create SQM instance…');
		oCreateSqm.onclick = ui.createHandlerFn(this, function(ev, section_id) {
			var dlDefault = uci.get('cake-autorate', section_id, 'base_dl_shaper_rate_kbps') ||
				(self.defaults.base_dl_shaper_rate_kbps || {}).value || 20000;
			var ulDefault = uci.get('cake-autorate', section_id, 'base_ul_shaper_rate_kbps') ||
				(self.defaults.base_ul_shaper_rate_kbps || {}).value || 10000;
			var ulIf = uci.get('cake-autorate', section_id, 'ul_if') || '';

			var ifaceInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': ulIf });
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
										ui.addNotification(null, E('p', {}, (res && res.error) || _('Failed to create SQM instance.')), 'error');
									}
								});
						}
					}, _('Create'))
				])
			]);
		});

		opt(s, 'general', form.Value, 'dl_if', _('Download interface'), {
			datatype: 'maxlength(15)',
			description: _("download side interface, usually SQM's ifb4<wan>"),
			modalonly: false,
			validate: function(section_id, value) {
				if (!value) return true;
				var others = uci.sections('cake-autorate', 'instance');
				for (var i = 0; i < others.length; i++) {
					if (others[i]['.name'] === section_id) continue;
					if (others[i].dl_if === value)
						return _('Interface already used by instance %s').format(others[i]['.name']);
				}
				return true;
			}
		});

		opt(s, 'general', form.Value, 'ul_if', _('Upload interface'), {
			datatype: 'maxlength(15)',
			modalonly: false,
			validate: function(section_id, value) {
				if (!value) return true;
				var others = uci.sections('cake-autorate', 'instance');
				for (var i = 0; i < others.length; i++) {
					if (others[i]['.name'] === section_id) continue;
					if (others[i].ul_if === value)
						return _('Interface already used by instance %s').format(others[i]['.name']);
				}
				return true;
			}
		});

		opt(s, 'general', form.Flag, 'adjust_dl_shaper_rate', _('Adjust download shaper rate'));
		opt(s, 'general', form.Flag, 'adjust_ul_shaper_rate', _('Adjust upload shaper rate'));

		/* min <= base <= max cross-field validation, DL and UL. Reads the
		 * sibling *form* value (falling back to the defaults placeholder
		 * when empty) so the check reflects what the user is about to save. */
		function fieldValue(section_id, key) {
			var lookup = m.lookupOption(key, section_id);
			var v;
			if (lookup && lookup[0])
				v = lookup[0].formvalue(section_id);
			if (v === undefined || v === null || v === '')
				v = (defaults[key] || {}).value;
			return v;
		}

		function minBaseMaxValidate(loKey, midKey, hiKey) {
			return function(section_id, value) {
				var lo = fieldValue(section_id, loKey);
				var mid = fieldValue(section_id, midKey);
				var hi = fieldValue(section_id, hiKey);
				var nlo = parseFloat(lo), nmid = parseFloat(mid), nhi = parseFloat(hi);
				if (isNaN(nlo) || isNaN(nmid) || isNaN(nhi)) return true;
				if (nlo <= nmid && nmid <= nhi) return true;
				return _('min ≤ base ≤ max required');
			};
		}

		opt(s, 'general', form.Value, 'min_dl_shaper_rate_kbps', _('Min download shaper rate (kbps)'),
			{ datatype: 'uinteger', modalonly: false, validate: minBaseMaxValidate('min_dl_shaper_rate_kbps', 'base_dl_shaper_rate_kbps', 'max_dl_shaper_rate_kbps') });
		opt(s, 'general', form.Value, 'base_dl_shaper_rate_kbps', _('Base download shaper rate (kbps)'),
			{ datatype: 'uinteger', modalonly: false, validate: minBaseMaxValidate('min_dl_shaper_rate_kbps', 'base_dl_shaper_rate_kbps', 'max_dl_shaper_rate_kbps') });
		opt(s, 'general', form.Value, 'max_dl_shaper_rate_kbps', _('Max download shaper rate (kbps)'),
			{ datatype: 'uinteger', modalonly: false, validate: minBaseMaxValidate('min_dl_shaper_rate_kbps', 'base_dl_shaper_rate_kbps', 'max_dl_shaper_rate_kbps') });

		opt(s, 'general', form.Value, 'min_ul_shaper_rate_kbps', _('Min upload shaper rate (kbps)'),
			{ datatype: 'uinteger', validate: minBaseMaxValidate('min_ul_shaper_rate_kbps', 'base_ul_shaper_rate_kbps', 'max_ul_shaper_rate_kbps') });
		opt(s, 'general', form.Value, 'base_ul_shaper_rate_kbps', _('Base upload shaper rate (kbps)'),
			{ datatype: 'uinteger', validate: minBaseMaxValidate('min_ul_shaper_rate_kbps', 'base_ul_shaper_rate_kbps', 'max_ul_shaper_rate_kbps') });
		opt(s, 'general', form.Value, 'max_ul_shaper_rate_kbps', _('Max upload shaper rate (kbps)'),
			{ datatype: 'uinteger', validate: minBaseMaxValidate('min_ul_shaper_rate_kbps', 'base_ul_shaper_rate_kbps', 'max_ul_shaper_rate_kbps') });

		opt(s, 'general', form.Value, 'connection_active_thr_kbps', _('Connection active threshold (kbps)'), { datatype: 'uinteger' });

		opt(s, 'general', form.Flag, 'sqm_sync_base_rates', _('Sync SQM base rates on save'),
			{ description: _('Keep the linked SQM instance download/upload set to the base rates on save') });

		/* ══════════════════════════════ pinger ══════════════════════════════ */

		var oMethod = opt(s, 'pinger', form.ListValue, 'pinger_method', _('Pinger method'));
		PINGER_METHODS.forEach(function(m2) {
			var key = PING_KEY_MAP[m2.key] || m2.key;
			var label = m2.label;
			if (sysinfo.pingers && sysinfo.pingers[key] === false)
				label += ' (' + _('not installed') + ')';
			oMethod.value(m2.key, label);
		});

		opt(s, 'pinger', form.Value, 'no_pingers', _('Number of pingers'), { datatype: 'uinteger' });
		opt(s, 'pinger', form.Value, 'reflector_ping_interval_s', _('Reflector ping interval (s)'), { datatype: 'ufloat' });
		opt(s, 'pinger', form.DynamicList, 'reflectors', _('Reflectors'), { datatype: 'host' });
		opt(s, 'pinger', form.Value, 'reflectors_url', _('Reflectors URL'));
		opt(s, 'pinger', form.Value, 'reflectors_url_skip_lines', _('Reflectors URL: lines to skip'), { datatype: 'uinteger' });
		opt(s, 'pinger', form.Flag, 'randomize_reflectors', _('Randomize reflectors'));
		opt(s, 'pinger', form.Flag, 'retain_reflector_stats', _('Retain reflector stats'));
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
				oProbe.value('mwan3:' + w.name, 'mwan3: ' + w.name + ' (' + w.device + ')');
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
			var prefixOpt = this.map.lookupOption('ping_prefix_string', section_id);
			var extraOpt = this.map.lookupOption('ping_extra_args', section_id);
			var prefixInput = (prefixOpt && prefixOpt[0]) ? prefixOpt[0].getUIElement(section_id) : null;
			var extraInput = (extraOpt && extraOpt[0]) ? extraOpt[0].getUIElement(section_id) : null;
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

		opt(s, 'sleep', form.Flag, 'enable_sleep_function', _('Enable sleep function'));
		opt(s, 'sleep', form.Value, 'sustained_idle_sleep_thr_s', _('Sustained idle sleep threshold (s)'), { datatype: 'ufloat' });
		opt(s, 'sleep', form.Flag, 'min_shaper_rates_enforcement', _('Enforce minimum shaper rates'));
		opt(s, 'sleep', form.Value, 'stall_detection_thr', _('Stall detection threshold'), { datatype: 'uinteger' });
		opt(s, 'sleep', form.Value, 'connection_stall_thr_kbps', _('Connection stall threshold (kbps)'), { datatype: 'uinteger' });
		opt(s, 'sleep', form.Value, 'global_ping_response_timeout_s', _('Global ping response timeout (s)'), { datatype: 'ufloat' });
		opt(s, 'sleep', form.Value, 'startup_wait_s', _('Startup wait (s)'), { datatype: 'ufloat' });
		opt(s, 'sleep', form.Value, 'if_up_check_interval_s', _('Interface up check interval (s)'), { datatype: 'ufloat' });
		opt(s, 'sleep', form.Value, 'monitor_achieved_rates_interval_ms', _('Monitor achieved rates interval (ms)'), { datatype: 'uinteger' });
		opt(s, 'sleep', form.Value, 'monitor_cpu_usage_interval_ms', _('Monitor CPU usage interval (ms)'), { datatype: 'uinteger' });

		/* ══════════════════════════════ logging ══════════════════════════════ */

		opt(s, 'logging', form.Flag, 'output_processing_stats', _('Output processing stats'));
		opt(s, 'logging', form.Flag, 'output_load_stats', _('Output load stats'));
		opt(s, 'logging', form.Flag, 'output_reflector_stats', _('Output reflector stats'));
		opt(s, 'logging', form.Flag, 'output_summary_stats', _('Output summary stats'));
		opt(s, 'logging', form.Flag, 'output_cake_changes', _('Output CAKE changes'));
		opt(s, 'logging', form.Flag, 'output_cpu_stats', _('Output CPU stats'));
		opt(s, 'logging', form.Flag, 'output_cpu_raw_stats', _('Output raw CPU stats'));
		opt(s, 'logging', form.Flag, 'debug', _('Debug'));
		opt(s, 'logging', form.Flag, 'log_DEBUG_messages_to_syslog', _('Log DEBUG messages to syslog'));
		opt(s, 'logging', form.Flag, 'log_to_file', _('Log to file'));
		opt(s, 'logging', form.Flag, 'log_file_export_compress', _('Compress exported log file'));

		opt(s, 'logging', form.Value, 'log_file_max_time_mins', _('Log file max time (mins)'), { datatype: 'uinteger' });
		opt(s, 'logging', form.Value, 'log_file_max_size_KB', _('Log file max size (KB)'), { datatype: 'uinteger' });
		opt(s, 'logging', form.Value, 'log_file_buffer_timeout_ms', _('Log file buffer timeout (ms)'), { datatype: 'uinteger' });
		opt(s, 'logging', form.Value, 'status_file_interval_ms', _('Status file interval (ms)'), { datatype: 'uinteger' });
		opt(s, 'logging', form.Value, 'log_file_path_override', _('Log file path override'));

		return m.render();
	}
});
