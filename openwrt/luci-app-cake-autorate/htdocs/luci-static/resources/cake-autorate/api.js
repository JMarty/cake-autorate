'use strict';
'require rpc';
'require baseclass';

var callStatus = rpc.declare({ object: 'cake-autorate', method: 'status', expect: { '': {} } });
var callDefaults = rpc.declare({ object: 'cake-autorate', method: 'defaults', expect: { '': {} } });
var callInstanceControl = rpc.declare({ object: 'cake-autorate', method: 'instance_control', params: ['id', 'action'], expect: { '': {} } });
var callCheckConfig = rpc.declare({ object: 'cake-autorate', method: 'check_config', params: ['id'], expect: { '': {} } });
var callLogTail = rpc.declare({ object: 'cake-autorate', method: 'log_tail', params: ['id', 'lines'], expect: { '': {} } });
var callLogExport = rpc.declare({ object: 'cake-autorate', method: 'log_export', params: ['id'], expect: { '': {} } });
var callLogReset = rpc.declare({ object: 'cake-autorate', method: 'log_reset', params: ['id'], expect: { '': {} } });
var callSystemInfo = rpc.declare({ object: 'cake-autorate', method: 'system_info', expect: { '': {} } });
var callSqmCreate = rpc.declare({ object: 'cake-autorate', method: 'sqm_create', params: ['interface', 'dl_kbps', 'ul_kbps'], expect: { '': {} } });
var callSqmSyncRates = rpc.declare({ object: 'cake-autorate', method: 'sqm_sync_rates', params: ['sqm_id', 'dl_kbps', 'ul_kbps'], expect: { '': {} } });
var callMqttStatus = rpc.declare({ object: 'cake-autorate', method: 'mqtt_status', expect: { '': {} } });
var callInitAction = rpc.declare({ object: 'luci', method: 'setInitAction', params: ['name', 'action'], expect: { result: false } });
var callFileRead = rpc.declare({ object: 'file', method: 'read', params: ['path'], expect: { data: '' } });

return baseclass.extend({
	getStatus: callStatus,
	getDefaults: callDefaults,
	instanceControl: callInstanceControl,
	checkConfig: callCheckConfig,
	logTail: callLogTail,
	logExport: callLogExport,
	logReset: callLogReset,
	getSystemInfo: callSystemInfo,
	sqmCreate: callSqmCreate,
	sqmSyncRates: callSqmSyncRates,
	getMqttStatus: callMqttStatus,
	callInitAction: callInitAction,
	callFileRead: callFileRead,

	fmtKbps: function(kbps) {
		if (kbps == null || isNaN(kbps)) return '-';
		if (kbps >= 1000) return (kbps / 1000).toFixed(1) + ' ' + _('Mbit/s');
		return kbps + ' ' + _('kbit/s');
	},

	fmtUptime: function(s) {
		if (s == null || isNaN(s)) return '-';
		if (s < 60) return s + _('s');
		if (s < 3600) return Math.floor(s / 60) + _('m') + ' ' + (s % 60) + _('s');
		if (s < 86400) return Math.floor(s / 3600) + _('h') + ' ' + Math.floor((s % 3600) / 60) + _('m');
		return Math.floor(s / 86400) + _('d') + ' ' + Math.floor((s % 86400) / 3600) + _('h');
	},

	fmtMs: function(x) {
		if (x == null || isNaN(x)) return '-';
		return Number(x).toFixed(1) + ' ' + _('ms');
	},

	/* One instance object from getStatus().instances -> UI state key.
	 * running + status.state        -> running | idle | stall | waiting_for_if
	 * running + no status yet       -> starting        (startup_wait / verify_ifs)
	 * running + stale status        -> starting        (status writer not up yet)
	 * !running + enabled + exitcode -> crashed
	 * !running + enabled            -> stopped
	 * !enabled                      -> disabled
	 */
	deriveState: function(inst) {
		if (inst.running) {
			if (!inst.status || inst.stale) return 'starting';
			return inst.status.state || 'running';
		}
		if (inst.enabled) return (inst.exit_code && inst.exit_code !== 0) ? 'crashed' : 'stopped';
		return 'disabled';
	},

	STATE_META: {
		running:        { color: '#1a7f1a', label: _('Running') },
		idle:           { color: '#888888', label: _('Idle (sleeping)') },
		stall:          { color: '#cc0000', label: _('Stall') },
		waiting_for_if: { color: '#c07700', label: _('Waiting for interface') },
		starting:       { color: '#c07700', label: _('Starting…') },
		crashed:        { color: '#cc0000', label: _('Crashed / restarting') },
		stopped:        { color: '#888888', label: _('Stopped') },
		disabled:       { color: '#888888', label: _('Disabled') }
	}
});
