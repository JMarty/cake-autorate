'use strict';
'require view';
'require poll';
'require ui';
'require uci';
'require dom';
'require cake-autorate.api as api';
'require cake-autorate.charts as charts';

/*
 * overview.js -- live status page: one card per configured instance, each
 * with a state/uptime/pid header, Start/Stop/Restart buttons, a warning
 * strip, a stats table and two rolling charts (bandwidth + OWD latency).
 * Polls `cake-autorate status` every 2s and updates the built DOM in place
 * (see buildCard()/updateCard()) rather than rebuilding cards each tick.
 */

/* UCI pinger_method values use a hyphen; system_info.pingers keys use '_'. */
var PING_KEY_MAP = { 'fping-ts': 'fping_ts' };

/* Pingers that measure round-trip time: cake-autorate feeds the same
 * value to DL and UL, so the latency chart shows it as one series. */
var RTT_PINGERS = { 'fping': true, 'ping': true };

/* Threshold guides for the latency chart; DL/UL are drawn separately only
 * when their values differ. */
function latencyGuides(st) {
	var guides = [];
	function pair(key, label, dlColor, ulColor) {
		var dl = st.dl[key], ul = st.ul[key];
		if (dl != null && dl === ul) {
			guides.push({ value: dl, label: label, color: dlColor });
			return;
		}
		if (dl != null) guides.push({ value: dl, label: _('DL %s').format(label), color: dlColor });
		if (ul != null) guides.push({ value: ul, label: _('UL %s').format(label), color: ulColor });
	}
	pair('delay_thr_ms', _('delay threshold'), '#cc0000', '#e8697a');
	pair('max_adjust_down_thr_ms', _('max adjust-down threshold'), '#e08800', '#f2c14e');
	return guides;
}

var LOAD_LABEL = {
	idle: _('Idle'),
	low: _('Low'),
	high: _('High')
};

/* Used whenever getStatus() didn't report on an instance at all (res.ok
 * === false, or the id is simply missing from res.instances). Renders as
 * a safe "no data" state and never trips the cake_present warning. */
function fallbackInst() {
	return {
		enabled: false, running: false, pid: 0, exit_code: 0, stale: false,
		status: null,
		cake_present: { dl: true, ul: true },
		tc_bandwidth_kbps: { dl: 0, ul: 0 }
	};
}

/* Status data is only trustworthy while the instance runs and its status
 * file is fresh; otherwise show "no data" rather than the last values. */
function liveStatus(inst) {
	return (inst.running && !inst.stale) ? inst.status : null;
}

/* Configured value of `key` for instance `id`: the instance option, else the
 * global section (instances inherit unset options from it). */
function cfg(id, key) {
	var v = uci.get('cake-autorate', id, key);
	if (v == null || v === '') v = uci.get('cake-autorate', 'global', key);
	return (v == null || v === '') ? null : v;
}

function ifaceText(id, inst) {
	var st = inst.status;
	var dl = (st && st.dl_if) || cfg(id, 'dl_if') || '-';
	var ul = (st && st.ul_if) || cfg(id, 'ul_if') || '-';
	return dl + ' / ' + ul;
}

function computeWarnings(id, inst, sysinfo, totalInstances) {
	var msgs = [];
	if (inst.config_errors && inst.config_errors.length)
		msgs.push(E('span', {}, [
			_('Configuration error — the instance cannot start: %s').format(inst.config_errors.join('; ')),
			' ',
			E('a', { 'href': L.url('admin/services/cake-autorate/instances') }, _('Go to the Instances page.'))
		]));
	var ifaces = { dl: (inst.status && inst.status.dl_if) || cfg(id, 'dl_if') || '-',
	               ul: (inst.status && inst.status.ul_if) || cfg(id, 'ul_if') || '-' };

	if (inst.cake_present) {
		if (inst.cake_present.dl === false)
			msgs.push(_('No CAKE qdisc on %s — is SQM enabled on this interface?').format(ifaces.dl));
		if (inst.cake_present.ul === false)
			msgs.push(_('No CAKE qdisc on %s — is SQM enabled on this interface?').format(ifaces.ul));
	}

	var method = cfg(id, 'pinger_method') || 'fping';
	var pingerKey = PING_KEY_MAP[method] || method;
	if (sysinfo && sysinfo.pingers && sysinfo.pingers[pingerKey] === false)
		msgs.push(_('Pinger method "%s" is not installed on this device.').format(method));

	if (totalInstances > 1) {
		var prefix = cfg(id, 'ping_prefix_string');
		var extra = cfg(id, 'ping_extra_args');
		if (!prefix && !extra)
			msgs.push(_('Multi-WAN: probes may not go out through this WAN — set probe routing on the Instances page.'));
	}

	var sqmId = uci.get('cake-autorate', id, 'sqm_instance');
	if (sqmId && sysinfo && sysinfo.sqm) {
		for (var i = 0; i < sysinfo.sqm.length; i++) {
			if (sysinfo.sqm[i].id === sqmId) {
				if (!sysinfo.sqm[i].enabled)
					msgs.push(_('The assigned SQM instance is disabled.'));
				break;
			}
		}
	}

	return msgs;
}

function renderWarnings(el, msgs) {
	dom.content(el, msgs.length ? msgs.map(function(m) { return E('p', {}, [ m ]); }) : '');
	el.style.display = msgs.length ? '' : 'none';
}

function renderReflectors(el, inst) {
	var st = liveStatus(inst);
	if (!st || !st.reflectors) {
		dom.content(el, [ _('Reflectors: -') ]);
		return;
	}
	dom.content(el, [ _('Reflectors: %s active — %s (%s)').format(st.reflectors.active,
		st.reflectors.list.join(', '), st.pinger_method || '-') ]);
}

function buildStatRow(dirLabel) {
	var cells = {
		shaper: E('td', { 'class': 'td', 'data-title': _('Shaper') }, '-'),
		achieved: E('td', { 'class': 'td', 'data-title': _('Achieved') }, '-'),
		load: E('td', { 'class': 'td', 'data-title': _('Load') }, '-'),
		owd: E('td', { 'class': 'td', 'data-title': _('OWD Δ') }, '-'),
		bb: E('td', { 'class': 'td', 'data-title': _('Bufferbloat') }, '-'),
		range: E('td', { 'class': 'td', 'data-title': _('Min / Base / Max') }, '-')
	};
	var tr = E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td' }, dirLabel),
		cells.shaper, cells.achieved, cells.load, cells.owd, cells.bb, cells.range
	]);
	return { tr: tr, cells: cells };
}

function updateStatRow(cells, d) {
	if (!d) {
		cells.shaper.textContent = '-';
		cells.achieved.textContent = '-';
		cells.load.textContent = '-';
		cells.owd.textContent = '-';
		cells.owd.style.color = '';
		cells.bb.textContent = '-';
		cells.range.textContent = '-';
		return;
	}
	cells.shaper.textContent = api.fmtKbps(d.shaper_kbps);
	cells.achieved.textContent = api.fmtKbps(d.achieved_kbps);
	cells.load.textContent = LOAD_LABEL[d.load] || d.load || '-';
	cells.owd.textContent = api.fmtMs(d.avg_owd_delta_ms);
	cells.owd.style.color = (d.avg_owd_delta_ms != null && d.delay_thr_ms != null &&
		d.avg_owd_delta_ms > d.delay_thr_ms) ? '#cc0000' : '';
	cells.bb.textContent = (d.sum_delays != null ? d.sum_delays : '-') + (d.bufferbloat ? ' ' + _('(active)') : '');
	cells.range.textContent = api.fmtKbps(d.min_kbps) + ' / ' + api.fmtKbps(d.base_kbps) + ' / ' + api.fmtKbps(d.max_kbps);
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: function() {
		return Promise.all([
			uci.load('cake-autorate'),
			api.getSystemInfo(),
			api.getStatus()
		]);
	},

	/* Build a card's DOM once; returns the element refs updateCard() needs
	 * to patch it in place on every subsequent poll tick. */
	buildCard: function(id, inst, totalInstances) {
		var self = this;
		inst = inst || fallbackInst();

		var meta = api.STATE_META[api.deriveState(inst)] || api.STATE_META.disabled;

		var stateDot = E('span', { 'style': 'display:inline-block;width:10px;height:10px;border-radius:5px;background:' + meta.color });
		var stateLabel = E('span', {}, meta.label);
		var ifaceLabel = E('span', {}, [ ifaceText(id, inst) ]);
		var st = liveStatus(inst);
		var uptimeLabel = E('span', {}, (st && st.uptime_s != null) ? api.fmtUptime(st.uptime_s) : '-');
		var pidLabel = E('span', {}, inst.pid ? String(inst.pid) : '-');

		function ctrlButton(label, style, action) {
			return E('button', {
				'class': 'btn cbi-button cbi-button-' + style,
				'click': ui.createHandlerFn(self, function() {
					return api.instanceControl(id, action).then(function(res) {
						if (!res || !res.ok)
							ui.addNotification(null, E('p', {}, [ (res && res.error) || _('Action failed') ]), 'error');
						return self.pollTick();
					});
				})
			}, label);
		}

		var dlRow = buildStatRow(_('DL'));
		var ulRow = buildStatRow(_('UL'));
		updateStatRow(dlRow.cells, st && st.dl);
		updateStatRow(ulRow.cells, st && st.ul);

		var table = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, ''),
				E('th', { 'class': 'th' }, _('Shaper')),
				E('th', { 'class': 'th' }, _('Achieved')),
				E('th', { 'class': 'th' }, _('Load')),
				E('th', { 'class': 'th' }, _('OWD Δ')),
				E('th', { 'class': 'th' }, _('Bufferbloat')),
				E('th', { 'class': 'th' }, _('Min / Base / Max'))
			]),
			dlRow.tr, ulRow.tr
		]);

		/* 900 samples at the 2s poll = 30 minutes of history. */
		var chartGroup = new charts.ChartGroup({ capacity: 900 });
		var bwChart = new charts.TimeSeriesChart({
			group: chartGroup,
			series: [
				{ key: 'dl_sh', label: _('DL shaper'), color: '#2266cc', width: 2 },
				{ key: 'dl_ac', label: _('DL achieved'), color: '#2266cc', fill: 'rgba(34,102,204,.15)' },
				{ key: 'ul_sh', label: _('UL shaper'), color: '#cc7722', width: 2 },
				{ key: 'ul_ac', label: _('UL achieved'), color: '#cc7722', fill: 'rgba(204,119,34,.15)' }
			],
			height: 140,
			fmt: api.fmtKbps,
			fmtAxis: api.fmtKbpsAxis,
			title: _('Bandwidth')
		});

		var chartsWrap = E('div', {}, [ chartGroup.renderControls(), bwChart.render() ]);

		var warningsEl = E('div', { 'class': 'alert-message warning', 'style': 'display:none' }, []);
		var reflectorsEl = E('div', { 'style': 'font-size:12px;opacity:.75;margin-top:4px' }, '-');

		renderWarnings(warningsEl, computeWarnings(id, inst, this.sysinfo, totalInstances));
		renderReflectors(reflectorsEl, inst);

		var root = E('div', { 'class': 'cbi-section', 'data-instance': id }, [
			E('div', { 'style': 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' }, [
				E('strong', {}, id),
				ifaceLabel,
				stateDot,
				stateLabel,
				E('span', {}, [ _('Uptime') + ': ', uptimeLabel ]),
				E('span', {}, [ _('PID') + ': ', pidLabel ]),
				E('div', { 'style': 'margin-left:auto;display:flex;gap:6px' }, [
					ctrlButton(_('Start'), 'apply', 'start'),
					ctrlButton(_('Stop'), 'reset', 'stop'),
					ctrlButton(_('Restart'), 'reload', 'restart')
				])
			]),
			warningsEl,
			table,
			chartsWrap,
			reflectorsEl
		]);

		return {
			root: root,
			stateDot: stateDot,
			stateLabel: stateLabel,
			ifaceLabel: ifaceLabel,
			uptimeLabel: uptimeLabel,
			pidLabel: pidLabel,
			cells: { dl: dlRow.cells, ul: ulRow.cells },
			warningsEl: warningsEl,
			reflectorsEl: reflectorsEl,
			chartsWrap: chartsWrap,
			chartGroup: chartGroup,
			bwChart: bwChart,
			latencyChart: null,
			latencyRtt: null
		};
	},

	/* Patch an already-built card in place for one poll tick. Never
	 * recreates the bandwidth chart; the latency chart is created lazily,
	 * the first time a non-null status arrives, and rebuilt only if the
	 * pinger switches between RTT and OWD measurement. Its threshold guides
	 * follow the live status every tick. */
	updateCard: function(card, id, inst) {
		var meta = api.STATE_META[api.deriveState(inst)] || api.STATE_META.disabled;
		card.stateDot.style.background = meta.color;
		card.stateLabel.textContent = meta.label;
		card.ifaceLabel.textContent = ifaceText(id, inst);

		var st = liveStatus(inst);
		card.uptimeLabel.textContent = (st && st.uptime_s != null) ? api.fmtUptime(st.uptime_s) : '-';
		card.pidLabel.textContent = inst.pid ? String(inst.pid) : '-';

		updateStatRow(card.cells.dl, st && st.dl);
		updateStatRow(card.cells.ul, st && st.ul);

		renderWarnings(card.warningsEl, computeWarnings(id, inst, this.sysinfo, this.totalInstances));
		renderReflectors(card.reflectorsEl, inst);

		var haveRates = !!(st && st.dl && st.ul);

		card.chartGroup.tick();
		card.bwChart.push(haveRates ? {
			dl_sh: st.dl.shaper_kbps, dl_ac: st.dl.achieved_kbps,
			ul_sh: st.ul.shaper_kbps, ul_ac: st.ul.achieved_kbps
		} : {});

		if (haveRates) {
			var rtt = !!RTT_PINGERS[st.pinger_method];
			if (card.latencyChart && card.latencyRtt !== rtt) {
				card.latencyChart.destroy();
				card.latencyChart = null;
			}
			if (!card.latencyChart) {
				card.latencyRtt = rtt;
				card.latencyChart = new charts.TimeSeriesChart({
					group: card.chartGroup,
					series: rtt ? [
						{ key: 'dl_owd', label: _('OWD Δ (estimated as RTT/2, same for DL and UL)'), color: '#7a4fb5', width: 2 }
					] : [
						{ key: 'dl_owd', label: _('DL OWD Δ'), color: '#2266cc', width: 2 },
						{ key: 'ul_owd', label: _('UL OWD Δ'), color: '#cc7722', width: 2 }
					],
					height: 140,
					fmt: api.fmtMs,
					fmtAxis: function(v) { return _('%s ms').format(v >= 10 ? Math.round(v) : Math.round(v * 10) / 10); },
					title: _('Latency')
				});
				card.chartsWrap.appendChild(card.latencyChart.render());
			}
			card.latencyChart.setGuides(latencyGuides(st));
		}
		if (card.latencyChart)
			card.latencyChart.push(haveRates ? { dl_owd: st.dl.avg_owd_delta_ms, ul_owd: st.ul.avg_owd_delta_ms } : {});
	},

	/* One poll tick: fetch status once, patch every built card. Tolerates
	 * res.ok === false and a missing/partial `instances` map -- instances
	 * with no data fall back to fallbackInst() so charts gap instead of
	 * throwing. */
	pollTick: function() {
		var self = this;
		return api.getStatus().then(function(res) {
			var ok = !!(res && res.ok !== false);
			var instances = (ok && res.instances) ? res.instances : {};

			if (self.versionLabel && ok && res.version)
				self.versionLabel.textContent = res.version;

			for (var id in self.cards)
				self.updateCard(self.cards[id], id, instances[id] || fallbackInst());
		}).catch(function() {
			/* transient RPC/poll error: keep showing the last known state */
		});
	},

	render: function(data) {
		var self = this;
		this.sysinfo = data[1] || {};
		var status = data[2] || {};
		var instances = (status.ok !== false && status.instances) ? status.instances : {};

		var sections = uci.sections('cake-autorate', 'instance');
		this.totalInstances = sections.length;
		this.cards = {};

		function globalButton(label, style, action) {
			return E('button', {
				'class': 'btn cbi-button cbi-button-' + style,
				'click': ui.createHandlerFn(self, function() {
					return api.serviceControl('cake-autorate', action).then(function(res) {
						if (!res || !res.ok)
							ui.addNotification(null, E('p', {}, [ (res && res.error) || _('Action failed') ]), 'error');
						return self.pollTick();
					});
				})
			}, label);
		}

		var versionLabel = E('span', { 'style': 'opacity:.7;font-size:12px;margin-left:8px' },
			[ status.version || '' ]);
		this.versionLabel = versionLabel;

		var header = E('div', { 'class': 'cbi-section' }, [
			E('div', { 'style': 'display:flex;align-items:center;gap:10px' }, [
				E('h2', {}, [ _('CAKE Autorate'), versionLabel ]),
				E('div', { 'style': 'margin-left:auto;display:flex;gap:6px' }, [
					globalButton(_('Start all'), 'apply', 'start'),
					globalButton(_('Stop all'), 'reset', 'stop'),
					globalButton(_('Restart all'), 'reload', 'restart')
				])
			])
		]);

		var body;

		if (!sections.length) {
			body = E('div', { 'class': 'alert-message info' }, [
				E('p', {}, _('No instances configured yet.')),
				E('a', { 'href': L.url('admin/services/cake-autorate/instances') }, _('Go to the Instances page to add one.'))
			]);
		} else {
			var cardsWrap = E('div', {}, []);
			sections.forEach(function(sec) {
				var id = sec['.name'];
				var card = self.buildCard(id, instances[id], self.totalInstances);
				self.cards[id] = card;
				cardsWrap.appendChild(card.root);
			});
			body = cardsWrap;

			poll.add(L.bind(self.pollTick, self), 2);
		}

		poll.start();

		return E('div', {}, [ header, body ]);
	}
});
