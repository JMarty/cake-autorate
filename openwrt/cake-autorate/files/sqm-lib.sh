# shellcheck shell=sh
# sqm-lib.sh -- SQM helpers shared by /etc/init.d/cake-autorate and the rpcd plugin
# (sourced, busybox ash). Callers must have set SCRIPT_PREFIX, sourced /lib/functions.sh
# and run `config_load cake-autorate` (instance options are read with config_get);
# sqm options are read/written with the uci CLI so the loaded cake-autorate config is
# never replaced by the sqm one.
# shellcheck disable=SC2034,SC2154 # results (SQM_*) are read by the sourcing script, which also sets SCRIPT_PREFIX

# sqm_is_true <value>: sqm-scripts style boolean
sqm_is_true() {
	case "$1" in 1|on|true|yes|enabled) return 0 ;; *) return 1 ;; esac
}

# sqm_is_queue <sqm section>: a valid name that is a 'queue' section of /etc/config/sqm
sqm_is_queue() {
	case "$1" in ''|*[!A-Za-z0-9_]*) return 1 ;; *) ;; esac
	[ "$(uci -q get "sqm.$1")" = "queue" ]
}

# sqm_effective_ul_if <instance>: prints the upload interface the instance runs on
# (instance option -> global section -> defaults.sh; UCI stores only overrides).
sqm_effective_ul_if() {
	# shellcheck disable=SC3043 # 'local' is a busybox ash/dash builtin; OpenWrt's own functions.sh relies on it.
	local v
	config_get v "$1" ul_if
	[ -n "$v" ] || config_get v global ul_if
	[ -n "$v" ] || v=$(sed -n 's/^ul_if=\([^ #	]*\).*/\1/p' "$SCRIPT_PREFIX/defaults.sh")
	printf '%s' "$v"
}

# sqm_resolve_queue <instance>: the instance's linked SQM queue.
#   sqm_instance, if set and an existing queue (SQM_LINKED=1); otherwise the first
#   queue whose 'interface' is the instance's effective ul_if (SQM_LINKED=0).
# Sets SQM_QUEUE (empty when none) and SQM_LINKED; returns 1 when there is none.
sqm_resolve_queue() {
	# shellcheck disable=SC3043 # 'local' is a busybox ash/dash builtin; OpenWrt's own functions.sh relies on it.
	local inst="$1" s ifc q
	SQM_QUEUE=
	SQM_LINKED=0
	config_get s "$inst" sqm_instance
	if [ -n "$s" ] && sqm_is_queue "$s"; then
		SQM_QUEUE=$s
		SQM_LINKED=1
		return 0
	fi
	ifc=$(sqm_effective_ul_if "$inst")
	[ -n "$ifc" ] || return 1
	# -X: real section names (LuCI-created queues are anonymous, shown as @queue[N] otherwise)
	for q in $(uci -q -X show sqm 2>/dev/null | sed -n 's/^sqm\.\([A-Za-z0-9_]*\)=queue$/\1/p'); do
		if [ "$(uci -q get "sqm.$q.interface")" = "$ifc" ]; then
			SQM_QUEUE=$q
			return 0
		fi
	done
	return 1
}

# sqm_queue_enable <queue>: stage (no commit) enabled=1 and, unless the qdisc already is
# cake, qdisc=cake + script=piece_of_cake.qos. Returns 0 if anything changed and
# describes it in SQM_CHANGE.
sqm_queue_enable() {
	# shellcheck disable=SC3043 # 'local' is a busybox ash/dash builtin; OpenWrt's own functions.sh relies on it.
	local q="$1" qd
	SQM_CHANGE=
	if ! sqm_is_true "$(uci -q get "sqm.$q.enabled")"; then
		uci -q set "sqm.$q.enabled=1"
		SQM_CHANGE="switched on"
	fi
	qd=$(uci -q get "sqm.$q.qdisc")
	if [ "$qd" != "cake" ]; then
		uci -q set "sqm.$q.qdisc=cake"
		uci -q set "sqm.$q.script=piece_of_cake.qos"
		SQM_CHANGE="${SQM_CHANGE:+$SQM_CHANGE, }qdisc '${qd:-none}' -> cake (piece_of_cake.qos)"
	fi
	[ -n "$SQM_CHANGE" ]
}

# sqm_queue_disable <queue>: stage (no commit) enabled=0; returns 0 only if it was on.
sqm_queue_disable() {
	sqm_is_true "$(uci -q get "sqm.$1.enabled")" || return 1
	uci -q set "sqm.$1.enabled=0"
}

# sqm_apply: commit the staged sqm changes and reload sqm-scripts once.
sqm_apply() {
	uci -q commit sqm || return 1
	/etc/init.d/sqm reload >/dev/null 2>&1
	return 0
}
