'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require dom';
'require cake-autorate.api as api';

/*
 * mqtt.js -- MQTT publisher settings. A plain form.Map over the `mqtt`
 * named section, with a status panel above the form that is refreshed
 * from api.getMqttStatus() on load and after every service action
 * (start/stop/restart, "enable summary stats on all instances", and
 * Save & Apply). handleSaveApply restarts the mqtt-publisher init script
 * after the default map save/apply so config changes take effect
 * immediately -- see file header note on double-restart being harmless.
 */

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('cake-autorate'),
			api.getMqttStatus()
		]);
	},

	refreshStatus: function() {
		var self = this;
		return api.getMqttStatus().then(function(res) {
			self.status = res || {};
			self.renderStatusPanel();
		}).catch(function() {
			self.status = {};
			self.renderStatusPanel();
		});
	},

	enableSummaryStatsAll: function() {
		var self = this;
		var sections = uci.sections('cake-autorate', 'instance');
		sections.forEach(function(sec) {
			uci.set('cake-autorate', sec['.name'], 'output_summary_stats', '1');
		});
		return uci.save().then(function() {
			return ui.changes.apply(false);
		}).then(function() {
			ui.addNotification(null, E('p', {}, _('Summary stats enabled on all instances.')), 'info');
			return self.refreshStatus();
		}).catch(function(err) {
			ui.addNotification(null, E('p', {}, _('Failed to enable summary stats: %s').format(String((err && err.message) || err))), 'error');
		});
	},

	serviceAction: function(action) {
		var self = this;
		return api.callInitAction('mqtt-publisher', action).then(function(res) {
			if (!res)
				ui.addNotification(null, E('p', {}, _('Action failed')), 'error');
			return self.refreshStatus();
		});
	},

	renderStatusPanel: function() {
		var self = this;
		var status = this.status || {};

		var dot = E('span', {
			'style': 'display:inline-block;width:10px;height:10px;border-radius:5px;background:' +
				(status.running ? '#1a7f1a' : '#888888')
		});
		var label = E('span', {}, status.running ? _('Running') : _('Stopped'));

		var configuredNote = !status.configured
			? E('span', { 'style': 'color:#888;margin-left:6px' }, '(' + _('not configured') + ')')
			: '';

		function svcButton(text, style, action) {
			return E('button', {
				'class': 'btn cbi-button cbi-button-' + style,
				'click': ui.createHandlerFn(self, function() { return self.serviceAction(action); })
			}, text);
		}

		var header = E('div', { 'style': 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
			dot, label, configuredNote,
			E('div', { 'style': 'margin-left:auto;display:flex;gap:6px' }, [
				svcButton(_('Start'), 'apply', 'start'),
				svcButton(_('Stop'), 'reset', 'stop'),
				svcButton(_('Restart'), 'reload', 'restart')
			])
		]);

		var warnMsgs = [];

		if (!status.mosquitto_installed)
			warnMsgs.push(E('p', {}, _('mosquitto_pub is not installed — install the mosquitto-client-nossl package.')));

		var summaryInstances = status.summary_stats_enabled_instances || [];
		if (summaryInstances.length === 0) {
			warnMsgs.push(E('div', {}, [
				E('p', {}, _('No instance has output_summary_stats enabled — the publisher will have nothing to send.')),
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(self, function() { return self.enableSummaryStatsAll(); })
				}, _('Enable summary stats on all instances'))
			]));
		}

		var warnings = E('div', {
			'class': 'alert-message warning',
			'style': warnMsgs.length ? '' : 'display:none'
		}, warnMsgs);

		dom.content(this.statusPanel, [ header, warnings ]);
	},

	handleSaveApply: function(ev, mode) {
		var self = this;
		return this.super('handleSaveApply', [ ev, mode ]).then(function() {
			return api.callInitAction('mqtt-publisher', 'restart').catch(function() {});
		}).then(function() {
			return self.refreshStatus();
		});
	},

	render: function(data) {
		var self = this;
		this.status = data[1] || {};

		var m = new form.Map('cake-autorate', _('CAKE Autorate — MQTT Publisher'),
			_('Publish live status to an MQTT broker. Requires the mosquitto-client-nossl package and at least one instance with "Output summary stats" enabled.'));

		var s = m.section(form.NamedSection, 'mqtt', 'mqtt', _('MQTT settings'));
		s.addremove = false;

		var oEnabled = s.option(form.Flag, 'enabled', _('Enabled'));
		oEnabled.rmempty = false;

		var oHost = s.option(form.Value, 'host', _('Host'));
		oHost.datatype = 'host';

		var oPort = s.option(form.Value, 'port', _('Port'));
		oPort.datatype = 'port';
		oPort.placeholder = '1883';

		s.option(form.Value, 'user', _('User'));

		var oPassword = s.option(form.Value, 'password', _('Password'));
		oPassword.password = true;

		this.statusPanel = E('div', { 'class': 'cbi-section' }, []);
		this.renderStatusPanel();

		return m.render().then(function(mapEl) {
			return E('div', {}, [ self.statusPanel, mapEl ]);
		});
	}
});
