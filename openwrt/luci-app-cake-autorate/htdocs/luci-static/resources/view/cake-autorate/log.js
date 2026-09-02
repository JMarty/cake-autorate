'use strict';
'require view';
'require poll';
'require ui';
'require uci';
'require cake-autorate.api as api';

/*
 * log.js -- log viewer: tails the on-router log file for one instance,
 * with a lines cap, a client-side record-type filter and optional 5s
 * auto-refresh. Reset truncates the file (after confirmation); Export
 * downloads the gzip-compressed export produced by `cake-autorate log_export`
 * via the ubus `file read` call (base64-decoded into a Blob).
 */

var LINE_OPTIONS = [100, 500, 2000];
var TYPE_OPTIONS = ['DEBUG', 'INFO', 'SUMMARY', 'SHAPER', 'LOAD', 'REFLECTOR', 'CPU', 'ERROR'];

function fmtSize(bytes) {
	if (bytes == null || isNaN(bytes)) return '-';
	if (bytes < 1024) return bytes + ' B';
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
	return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/* base64 → Uint8Array, throws on malformed input (caller wraps in try/catch) */
function base64ToBytes(b64) {
	var bin = atob(b64);
	var bytes = new Uint8Array(bin.length);
	for (var i = 0; i < bin.length; i++)
		bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function basename(path) {
	var parts = String(path || '').split('/');
	return parts[parts.length - 1] || 'log.gz';
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function() {
		return uci.load('cake-autorate');
	},

	/* Client-side prefix filter on the first ';'-separated field, e.g. a
	 * "SUMMARY" filter also matches "SUMMARY_HEADER" lines -- intentional. */
	filterLines: function(lines, type) {
		if (!type) return lines;
		return lines.filter(function(line) {
			var idx = line.indexOf(';');
			var head = (idx === -1 ? line : line.substring(0, idx)).replace(/^\s+|\s+$/g, '');
			return head.indexOf(type) === 0;
		});
	},

	refresh: function() {
		var self = this;
		var id = self.instanceSelect ? self.instanceSelect.value : null;

		if (!id) {
			self.pathLabel.textContent = '-';
			self.sizeLabel.textContent = '-';
			self.pre.textContent = _('No instance selected.');
			return Promise.resolve();
		}

		var lines = parseInt(self.linesSelect.value, 10) || 500;

		return api.logTail(id, lines).then(function(res) {
			if (!res || res.ok === false) {
				self.pathLabel.textContent = '-';
				self.sizeLabel.textContent = '-';
				self.pre.textContent = ((res && res.error) || _('Failed to read log.')) + '\n\n' +
					_('Hint: log_to_file may be disabled for this instance, or the instance may be stopped.');
				return;
			}

			self.pathLabel.textContent = res.path || '-';
			self.sizeLabel.textContent = fmtSize(res.size);

			var filtered = self.filterLines(res.lines || [], self.typeSelect.value);
			self.pre.textContent = filtered.join('\n');
			self.pre.scrollTop = self.pre.scrollHeight;
		}).catch(function(err) {
			self.pathLabel.textContent = '-';
			self.sizeLabel.textContent = '-';
			self.pre.textContent = String((err && err.message) || err);
		});
	},

	handleReset_: function() {
		var self = this;
		var id = self.instanceSelect ? self.instanceSelect.value : null;
		if (!id) return;

		ui.showModal(_('Reset log'), [
			E('p', {}, _('This truncates the log file for instance "%s". Continue?').format(id)),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-negative',
					'click': ui.createHandlerFn(self, function() {
						return api.logReset(id).then(function(res) {
							ui.hideModal();
							if (!res || !res.ok) {
								ui.addNotification(null, E('p', {}, (res && res.error) || _('Failed to reset log.')), 'error');
								return;
							}
							ui.addNotification(null, E('p', {}, _('Log reset.')), 'info');
							return self.refresh();
						});
					})
				}, _('Reset log'))
			])
		]);
	},

	handleExport_: function() {
		var self = this;
		var id = self.instanceSelect ? self.instanceSelect.value : null;
		if (!id) return Promise.resolve();

		return api.logExport(id).then(function(res) {
			if (!res || !res.ok) {
				ui.addNotification(null, E('p', {}, (res && res.error) || _('Failed to export log.')), 'error');
				return;
			}

			return api.callFileRead(res.path).then(function(data) {
				try {
					var bytes = base64ToBytes(data || '');
					var blob = new Blob([ bytes ], { type: 'application/gzip' });
					var url = URL.createObjectURL(blob);
					var link = E('a', { 'href': url, 'download': basename(res.path) });
					document.body.appendChild(link);
					link.click();
					document.body.removeChild(link);
					URL.revokeObjectURL(url);
				} catch (e) {
					ui.addNotification(null, E('p', {}, _('Failed to prepare the log file for download: %s').format(String((e && e.message) || e))), 'error');
				}
			});
		}).catch(function(err) {
			ui.addNotification(null, E('p', {}, _('Failed to export log: %s').format(String((err && err.message) || err))), 'error');
		});
	},

	render: function() {
		var self = this;
		var sections = uci.sections('cake-autorate', 'instance');

		var pathLabel = E('span', {}, '-');
		var sizeLabel = E('span', {}, '-');
		var pre = E('pre', {
			'style': 'font-size:11px;max-height:600px;overflow:auto;background:#1b1b1b;color:#ddd;padding:8px'
		}, _('Select an instance and click Refresh.'));

		this.pathLabel = pathLabel;
		this.sizeLabel = sizeLabel;
		this.pre = pre;

		var instanceSelect = E('select', { 'class': 'cbi-input-select' });
		sections.forEach(function(sec) {
			instanceSelect.appendChild(E('option', { 'value': sec['.name'] }, sec['.name']));
		});
		this.instanceSelect = instanceSelect;

		var linesSelect = E('select', { 'class': 'cbi-input-select' });
		LINE_OPTIONS.forEach(function(n) {
			linesSelect.appendChild(E('option', {
				'value': String(n),
				'selected': (n === 500) ? 'selected' : null
			}, String(n)));
		});
		this.linesSelect = linesSelect;

		var typeSelect = E('select', { 'class': 'cbi-input-select' });
		typeSelect.appendChild(E('option', { 'value': '' }, _('All')));
		TYPE_OPTIONS.forEach(function(t) {
			typeSelect.appendChild(E('option', { 'value': t }, t));
		});
		this.typeSelect = typeSelect;

		/* re-filter/re-render the already-fetched lines without a new RPC
		 * round trip; the type select's change handler calls this instead
		 * of refresh(). Cheap since res.lines is small (<= 2000 entries). */
		typeSelect.addEventListener('change', ui.createHandlerFn(this, function() {
			return self.refresh();
		}));

		var autoRefreshCb = E('input', { 'type': 'checkbox', 'id': 'cake_autorate_log_autorefresh' });
		this.pollFn = L.bind(this.refresh, this);
		autoRefreshCb.addEventListener('change', function(ev) {
			if (ev.target.checked)
				poll.add(self.pollFn, 5);
			else
				poll.remove(self.pollFn);
		});

		var controls = E('div', { 'class': 'cbi-section', 'style': 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' }, [
			E('label', {}, [ _('Instance') + ': ', instanceSelect ]),
			E('label', {}, [ _('Lines') + ': ', linesSelect ]),
			E('label', {}, [ _('Type') + ': ', typeSelect ]),
			E('label', {}, [ autoRefreshCb, ' ' + _('Auto-refresh (5s)') ]),
			E('div', { 'style': 'margin-left:auto;display:flex;gap:6px' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, function() { return self.refresh(); })
				}, _('Refresh')),
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(this, function() { return self.handleReset_(); })
				}, _('Reset log')),
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, function() { return self.handleExport_(); })
				}, _('Export'))
			])
		]);

		instanceSelect.addEventListener('change', ui.createHandlerFn(this, function() { return self.refresh(); }));
		linesSelect.addEventListener('change', ui.createHandlerFn(this, function() { return self.refresh(); }));

		var meta = E('div', { 'class': 'cbi-section', 'style': 'font-size:12px;color:#888' }, [
			_('Path') + ': ', pathLabel, '  —  ', _('Size') + ': ', sizeLabel
		]);

		var body;
		if (!sections.length) {
			body = E('div', { 'class': 'alert-message info' }, [
				E('p', {}, _('No instances configured yet.')),
				E('a', { 'href': L.url('admin/services/cake-autorate/instances') }, _('Go to the Instances page to add one.'))
			]);
		} else {
			body = E('div', {}, [ controls, meta, pre ]);
			poll.start();
			/* first instance preselected -- kick off an initial fetch */
			this.refresh();
		}

		return E('div', {}, [
			E('h2', {}, _('CAKE Autorate — Log')),
			body
		]);
	}
});
