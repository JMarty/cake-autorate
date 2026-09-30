'use strict';
'require baseclass';
'require cake-autorate.api as api';

/*
 * 75_cake-autorate.js -- compact status-page widget shown on the LuCI
 * Overview page. One row per configured instance: state chip, shaper
 * rates, achieved rates and OWD delta for both directions. LuCI polls
 * status includes automatically (~5s); this file only needs load()/
 * render(), no poller of its own.
 *
 * Returns null (not E([])) when the rpcd object is absent or the package
 * has never been configured: LuCI's status page shows a section's box
 * whenever render() returns non-null content, so null keeps the widget
 * entirely hidden. Rates/OWD show '-' for an instance that is stopped or
 * whose status file is stale. The state chip comes from api.deriveState(),
 * including "Not shaping — no CAKE qdisc" (no_cake) for a running instance
 * whose interfaces have no CAKE qdisc.
 */

function stateChip(inst) {
	var meta = api.STATE_META[api.deriveState(inst)] || api.STATE_META.disabled;
	return E('div', { 'style': 'display:flex;align-items:center;gap:6px' }, [
		E('span', {
			'style': 'display:inline-block;width:10px;height:10px;border-radius:5px;background:' + meta.color
		}),
		E('span', {}, meta.label)
	]);
}

function rateCell(inst, key) {
	var st = inst.status;
	if (!inst.running || inst.stale || !st || !st.dl || !st.ul)
		return '-';
	return api.fmtKbps(st.dl[key]) + ' / ' + api.fmtKbps(st.ul[key]);
}

function owdCell(inst) {
	var st = inst.status;
	if (!inst.running || inst.stale || !st || !st.dl || !st.ul)
		return '-';
	return api.fmtMs(st.dl.avg_owd_delta_ms) + ' / ' + api.fmtMs(st.ul.avg_owd_delta_ms);
}

return baseclass.extend({
	title: _('CAKE Autorate'),

	load: function() {
		return api.getStatus().catch(function() { return null; });
	},

	render: function(res) {
		if (!res || !res.ok || !res.instances)
			return null;

		var ids = Object.keys(res.instances);
		if (!ids.length)
			return null;

		var rows = [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Instance')),
				E('th', { 'class': 'th' }, _('State')),
				E('th', { 'class': 'th' }, _('Shaper DL / UL')),
				E('th', { 'class': 'th' }, _('Achieved DL / UL')),
				E('th', { 'class': 'th' }, _('OWD Δ DL / UL'))
			])
		];

		ids.sort();
		for (var i = 0; i < ids.length; i++) {
			var id = ids[i];
			var inst = res.instances[id];

			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, id),
				E('td', { 'class': 'td' }, stateChip(inst)),
				E('td', { 'class': 'td' }, rateCell(inst, 'shaper_kbps')),
				E('td', { 'class': 'td' }, rateCell(inst, 'achieved_kbps')),
				E('td', { 'class': 'td' }, owdCell(inst))
			]));
		}

		return E('table', { 'class': 'table' }, rows);
	}
});
