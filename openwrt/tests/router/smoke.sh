#!/bin/sh
# On-router smoke test for the cake-autorate package. Usage: sh smoke.sh <instance-id>
id=${1:-primary}
fails=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }

check "rpcd object registered"      "ubus list | grep -qx cake-autorate"
check "status ok"                   "ubus call cake-autorate status | jsonfilter -e '@.ok' | grep -q true"
check "instance listed"             "ubus call cake-autorate status | jsonfilter -e '@.instances.$id' >/dev/null"
check "system_info ok"              "ubus call cake-autorate system_info | jsonfilter -e '@.sqm_installed' >/dev/null"
check "check_config valid"          "ubus call cake-autorate check_config '{\"id\":\"$id\"}' | jsonfilter -e '@.valid' | grep -q true"
check "bad id rejected"             "ubus call cake-autorate check_config '{\"id\":\"../x\"}' | jsonfilter -e '@.ok' | grep -q false"

/etc/init.d/cake-autorate reload; sleep 3
check "instance running"            "ubus call cake-autorate status | jsonfilter -e '@.instances.$id.running' | grep -q true"
sleep 3
check "status.json present"         "test -r /var/run/cake-autorate/$id/status.json"
check "status embedded"             "ubus call cake-autorate status | jsonfilter -e '@.instances.$id.status.state' | grep -qE 'running|idle|stall|waiting_for_if'"
check "log_tail ok"                 "ubus call cake-autorate log_tail '{\"id\":\"$id\",\"lines\":5}' | jsonfilter -e '@.ok' | grep -q true"

ubus call cake-autorate instance_control "{\"id\":\"$id\",\"action\":\"stop\"}" >/dev/null; sleep 2
check "stop: not running"           "ubus call cake-autorate status | jsonfilter -e '@.instances.$id.running' | grep -q false"
check "stop: run dir cleaned"       "! test -d /var/run/cake-autorate/$id"
ubus call cake-autorate instance_control "{\"id\":\"$id\",\"action\":\"start\"}" >/dev/null; sleep 3
check "start: running again"        "ubus call cake-autorate status | jsonfilter -e '@.instances.$id.running' | grep -q true"

# a config change must restart only the edited instance
pid_before=$(ubus call cake-autorate status | jsonfilter -e "@.instances.$id.pid")
uci set cake-autorate.$id.no_pingers=5; uci commit cake-autorate; /etc/init.d/cake-autorate reload; sleep 3
pid_after=$(ubus call cake-autorate status | jsonfilter -e "@.instances.$id.pid")
check "edited instance restarted"   "test \"$pid_before\" != \"$pid_after\""
uci revert cake-autorate 2>/dev/null; uci -q delete cake-autorate.$id.no_pingers; uci commit cake-autorate; /etc/init.d/cake-autorate reload

echo "$fails failure(s)"
[ "$fails" -eq 0 ]
