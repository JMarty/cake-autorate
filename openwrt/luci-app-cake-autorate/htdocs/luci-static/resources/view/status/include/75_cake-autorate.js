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
 * Renders nothing (E([])) when the rpcd object is absent or the package
 * has never been configured, so the widget stays silent rather than
 * showing an error on installs where it isn't wired up yet.
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

function rateCell(st, key) {
	if (!st || !st.dl || !st.ul)
		return '-';
	return api.fmtKbps(st.dl[key]) + ' / ' + api.fmtKbps(st.ul[key]);
}

function owdCell(st) {
	if (!st || !st.dl || !st.ul)
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
			return E([]);

		var ids = Object.keys(res.instances);
		if (!ids.length)
			return E([]);

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
			var st = inst.status;

			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, id),
				E('td', { 'class': 'td' }, stateChip(inst)),
				E('td', { 'class': 'td' }, rateCell(st, 'shaper_kbps')),
				E('td', { 'class': 'td' }, rateCell(st, 'achieved_kbps')),
				E('td', { 'class': 'td' }, owdCell(st))
			]));
		}

		return E('table', { 'class': 'table' }, rows);
	}
});
