#!/usr/bin/env bash
# rpcd plugin: status.sqm and the sqm_control method, with uci/jshn replaced by in-memory stubs.
# shellcheck disable=SC2154 # REPO_ROOT is exported by run-tests.sh
# shellcheck disable=SC2034 # SCRIPT_PREFIX/SQM_CONF/INPUT/SVC are read by the sourced rpcd functions
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
command -v jq >/dev/null || { echo "jq required"; exit 1; }
F="${REPO_ROOT}/openwrt/cake-autorate/files"
export UCI_CONFIG_DIR="${PWD}/fixtures/uci/sqmmanage"
. ./shim/openwrt-shim.sh

# in-memory uci + recording sqm init script (never the host's /etc/init.d/sqm)
declare -A SQMDB
. ./uci_stub.sh

# Source the plugin as a library: its /usr/share/libubox, /lib and /usr/lib includes do not
# exist here (bash reports and continues), and with no arguments the dispatcher does nothing.
set +u
# shellcheck disable=SC1090,SC1091
. "${F}/rpcd-cake-autorate" 2>/dev/null
# stays +u: OpenWrt's config_get references an unset $4 for a missing option (ash runs without -u)
assert_eq "plugin without its lib: SQM marked unavailable" "0" "${SQM_LIB_OK}"
# shellcheck disable=SC1091
. "${F}/sqm-lib.sh"
SQM_LIB_OK=1
SCRIPT_PREFIX="${REPO_ROOT}"
tmpd=$(mktemp -d)
SQM_CONF="${tmpd}/sqm"
: > "${SQM_CONF}"

# minimal jshn stand-in (flat objects only)
json_init() { JOUT=""; }
json_add_boolean() { JOUT="${JOUT}${JOUT:+,}\"$1\":$([ "$2" = 1 ] && echo true || echo false)"; }
json_add_string() { JOUT="${JOUT}${JOUT:+,}\"$1\":\"$(json_str "$2")\""; }
json_dump() { printf '{%s}\n' "${JOUT}"; }
json_load() { JIN="$1"; }
json_get_var() { printf -v "$1" '%s' "$(printf '%s' "${JIN}" | jq -r --arg k "$2" '.[$k] // empty')"; }

SQMDB=(
	[sqm.q2]=queue [sqm.q2.interface]=eth9 [sqm.q2.enabled]=0 [sqm.q2.qdisc]=cake [sqm.q2.script]=piece_of_cake.qos
	[sqm.q1]=queue [sqm.q1.interface]=eth1 [sqm.q1.enabled]=1 [sqm.q1.qdisc]='fq"codel' [sqm.q1.script]=simple.qos
	[sqm.q4]=queue [sqm.q4.interface]=eth4 [sqm.q4.enabled]=0 [sqm.q4.qdisc]=fq_codel [sqm.q4.script]=simple.qos
	[sqm.wanq]=queue [sqm.wanq.interface]=wan [sqm.wanq.enabled]=1 [sqm.wanq.qdisc]=cake [sqm.wanq.script]=layer_cake.qos
	[sqm.notq]=other
)
SQM_ORDER=(q2 q1 q4 wanq)

status_json() {
	SVC=""
	config_load cake-autorate
	SEP=""
	printf '{'
	config_foreach status_instance instance
	printf '}'
}
out=$(status_json 2>/dev/null)
if printf '%s' "${out}" | jq -e . >/dev/null 2>&1; then pass "status: valid json"; else fail "status: valid json" "${out}"; fi
sq() { printf '%s' "${out}" | jq -c ".$1.sqm"; }
assert_eq "status: linked queue" \
	'{"installed":true,"queue":"q1","linked":true,"enabled":true,"qdisc":"fq\"codel","script":"simple.qos","interface":"eth1","manage":true}' "$(sq m1)"
assert_eq "status: auto-detected queue by instance ul_if" \
	'{"installed":true,"queue":"q2","linked":false,"enabled":false,"qdisc":"cake","script":"piece_of_cake.qos","interface":"eth9","manage":true}' "$(sq m2)"
assert_eq "status: auto-detected queue by global ul_if" '"wanq"' "$(printf '%s' "${out}" | jq -c .m3.sqm.queue)"
assert_eq "status: no queue" \
	'{"installed":true,"queue":null,"linked":false,"enabled":false,"qdisc":"","script":"","interface":"","manage":false}' "$(sq u1)"
assert_eq "status: manage flag of a disabled instance" 'true' "$(printf '%s' "${out}" | jq -c .d1.sqm.manage)"
rm -f "${SQM_CONF}"
out=$(status_json 2>/dev/null)
assert_eq "status: sqm-scripts not installed" \
	'{"installed":false,"queue":null,"linked":false,"enabled":false,"qdisc":"","script":"","interface":"","manage":true}' "$(sq m1)"
: > "${SQM_CONF}"

# ---- sqm_control ----
ctl() { INPUT="$1"; do_sqm_control 2>/dev/null; }
assert_eq "sqm_control: invalid id" '{"ok":false,"error":"invalid sqm id"}' "$( (ctl '{"sqm_id":"a;b","action":"enable"}') )"
assert_eq "sqm_control: not a queue" "false" "$( (ctl '{"sqm_id":"notq","action":"enable"}') | jq -c .ok)"
assert_eq "sqm_control: missing queue" "false" "$( (ctl '{"sqm_id":"nosuch","action":"enable"}') | jq -c .ok)"
assert_eq "sqm_control: invalid action" '{"ok":false,"error":"invalid action"}' "$( (ctl '{"sqm_id":"q4","action":"toggle"}') )"
assert_eq "sqm_control: rejected calls commit nothing" "0" "${SQM_COMMITS}"
assert_eq "sqm_control: rejected calls reload nothing" "0" "$(sqm_reloads)"
ctl '{"sqm_id":"q4","action":"enable"}' > "${tmpd}/r"
assert_eq "sqm_control enable: ok" "true" "$(jq -c .ok "${tmpd}/r")"
assert_eq "sqm_control enable: enabled" "1" "${SQMDB[sqm.q4.enabled]}"
assert_eq "sqm_control enable: qdisc cake" "cake" "${SQMDB[sqm.q4.qdisc]}"
assert_eq "sqm_control enable: script piece_of_cake" "piece_of_cake.qos" "${SQMDB[sqm.q4.script]}"
assert_eq "sqm_control enable: one commit" "1" "${SQM_COMMITS}"
ctl '{"sqm_id":"q4","action":"enable"}' > "${tmpd}/r"
assert_eq "sqm_control enable again: ok" "true" "$(jq -c .ok "${tmpd}/r")"
assert_eq "sqm_control enable again: no commit" "1" "${SQM_COMMITS}"
assert_eq "sqm_control enable again: no reload" "1" "$(sqm_reloads)"
ctl '{"sqm_id":"wanq","action":"enable"}' > "${tmpd}/r"
assert_eq "sqm_control enable: cake with layer_cake script kept" "layer_cake.qos" "${SQMDB[sqm.wanq.script]}"
ctl '{"sqm_id":"q4","action":"disable"}' > "${tmpd}/r"
assert_eq "sqm_control disable: ok" "true" "$(jq -c .ok "${tmpd}/r")"
assert_eq "sqm_control disable: disabled" "0" "${SQMDB[sqm.q4.enabled]}"
assert_eq "sqm_control disable: qdisc kept" "cake" "${SQMDB[sqm.q4.qdisc]}"
assert_eq "sqm_control disable: commit" "2" "${SQM_COMMITS}"
assert_eq "sqm_control: reloads paired with commits" "2" "$(sqm_reloads)"

# lib missing: status reports null, sqm_control refuses, nothing is touched
SQM_LIB_OK=0
out=$(status_json 2>/dev/null)
assert_eq "no lib: status sqm null" "null" "$(printf '%s' "${out}" | jq -c .m1.sqm)"
assert_eq "no lib: status still has cake_present" "false" "$(printf '%s' "${out}" | jq -c .m1.cake_present.ul)"
assert_contains "no lib: sqm_control refuses" "sqm-lib.sh missing" "$( (ctl '{"sqm_id":"q4","action":"enable"}') )"
assert_eq "no lib: nothing committed" "2" "${SQM_COMMITS}"
SQM_LIB_OK=1

# listed and dispatched
list=$(bash "${F}/rpcd-cake-autorate" list 2>/dev/null)
assert_eq "list: sqm_control signature" '{"sqm_id":"str","action":"str"}' "$(printf '%s' "${list}" | jq -c .sqm_control)"
grep -q '^[[:space:]]*sqm_control)[[:space:]]*do_sqm_control' "${F}/rpcd-cake-autorate" && pass "dispatch: sqm_control" || fail "dispatch: sqm_control"
rm -rf "${tmpd}" "${SQM_STUB_DIR}"
report
