#!/usr/bin/env bash
# shellcheck disable=SC2154 # REPO_ROOT is exported by run-tests.sh
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
export UCI_CONFIG_DIR="${PWD}/fixtures/uci/basic"
PROCD_LOG=$(mktemp); export PROCD_LOG
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}"
export CAKE_AUTORATE_FUNCTIONS_SH="${PWD}/shim/openwrt-shim.sh"
cfg_dir=$(mktemp -d)
export CAKE_AUTORATE_CONFIG_PREFIX="${cfg_dir}"
. ./shim/openwrt-shim.sh

# On the router uci-to-config.sh sits in SCRIPT_PREFIX; here point the init script at the repo copy.
export CAKE_AUTORATE_UCI_TO_CONFIG="${REPO_ROOT}/openwrt/cake-autorate/files/uci-to-config.sh"
export CAKE_AUTORATE_SQM_LIB="${REPO_ROOT}/openwrt/cake-autorate/files/sqm-lib.sh"
# in-memory uci + recording sqm init script (never the host's /etc/init.d/sqm)
declare -A SQMDB=()
. ./uci_stub.sh

# Source the init script as a library (skip the rc.common shebang) and call its hooks.
. "${REPO_ROOT}/openwrt/cake-autorate/files/cake-autorate.init"
start_service
log=$(cat "${PROCD_LOG}")
assert_contains "enabled instance opened" "open wan" "${log}"
assert_not_contains "disabled instance skipped" "open lte" "${log}"
assert_contains "command" "param command ${REPO_ROOT}/cake-autorate.sh ${cfg_dir}/config.wan.sh" "${log}"
assert_contains "env" "param env CAKE_AUTORATE_SCRIPT_PREFIX=${REPO_ROOT} CAKE_AUTORATE_CONFIG_PREFIX=${cfg_dir}" "${log}"
assert_contains "file tracked" "param file ${cfg_dir}/config.wan.sh" "${log}"
assert_contains "respawn" "param respawn 3600 5 5" "${log}"
assert_contains "stderr" "param stderr 1" "${log}"
[ -f "${cfg_dir}/config.wan.sh" ] && pass "config rendered" || fail "config rendered"
[ -f "${cfg_dir}/config.lte.sh" ] && fail "disabled not rendered" || pass "disabled not rendered"
: > "${PROCD_LOG}"
service_triggers
assert_eq "reload trigger" "trigger cake-autorate" "$(cat "${PROCD_LOG}")"
assert_eq "no sqm change: no sqm reload" "0" "$(sqm_reloads)"
# --- sync_sqm_rates ---
SQMDB=( [sqm.wan]=queue [sqm.wan.download]=1000 [sqm.wan.upload]=2000 [sqm.other]=queue [sqm.other.download]=1 [sqm.other.upload]=2 [sqm.bad]=queue [sqm.bad.download]=5 [sqm.bad.upload]=6 )
export UCI_CONFIG_DIR="${PWD}/fixtures/uci/sqmsync"
rm -rf "${cfg_dir}"
cfg_dir=$(mktemp -d)
# shellcheck disable=SC2034 # read by the sourced init script's start_service
CONFIG_PREFIX="${cfg_dir}"
export CAKE_AUTORATE_CONFIG_PREFIX="${cfg_dir}"
: > "${PROCD_LOG}"
start_service
# wan: base_dl 30000 from the instance, base_ul 20000 falls back to defaults.sh
assert_eq "sqm download synced" "30000" "${SQMDB[sqm.wan.download]}"
assert_eq "sqm upload synced (defaults.sh fallback)" "20000" "${SQMDB[sqm.wan.upload]}"
assert_eq "sqm committed once" "1" "${SQM_COMMITS}"
assert_eq "sqm reloaded once" "1" "$(sqm_reloads)"
assert_eq "no sync flag: download untouched" "1" "${SQMDB[sqm.other.download]}"
assert_eq "no sync flag: upload untouched" "2" "${SQMDB[sqm.other.upload]}"
# badrate: explicit non-integer base_dl -> no defaults.sh fallback, queue untouched
assert_eq "non-integer base rate: download untouched" "5" "${SQMDB[sqm.bad.download]}"
assert_eq "non-integer base rate: upload untouched" "6" "${SQMDB[sqm.bad.upload]}"
assert_contains "non-integer base rate: logged" "base_dl_shaper_rate_kbps '30000.5' is not a whole number" "${SQM_LOG}"
start_service
assert_eq "equal rates: no second commit" "1" "${SQM_COMMITS}"
assert_eq "equal rates: no second reload" "1" "$(sqm_reloads)"

# --- manage_sqm: switch the linked SQM queue on at start and off at stop ---
# OpenWrt's config_get references an unset $4 for a missing option (not nounset-safe;
# ash on the router runs without -u). The fixtures below leave options unset on purpose.
set +u
SQMDB=(
	[sqm.q0]=queue [sqm.q0.interface]=eth8 [sqm.q0.enabled]=0 [sqm.q0.qdisc]=cake
	[sqm.q2]=queue [sqm.q2.interface]=eth9 [sqm.q2.enabled]=0 [sqm.q2.qdisc]=cake
	[sqm.q2b]=queue [sqm.q2b.interface]=eth9 [sqm.q2b.enabled]=0 [sqm.q2b.qdisc]=cake
	[sqm.q1]=queue [sqm.q1.interface]=eth1 [sqm.q1.enabled]=0 [sqm.q1.qdisc]=fq_codel [sqm.q1.script]=simple.qos [sqm.q1.download]=1 [sqm.q1.upload]=2
	[sqm.q3]=queue [sqm.q3.interface]=eth3 [sqm.q3.enabled]=0 [sqm.q3.qdisc]=fq_codel [sqm.q3.script]=simple.qos
	[sqm.q4]=queue [sqm.q4.interface]=eth4 [sqm.q4.enabled]=1 [sqm.q4.qdisc]=cake
	[sqm.q5]=queue [sqm.q5.interface]=wan [sqm.q5.enabled]=0 [sqm.q5.qdisc]=cake
)
# shellcheck disable=SC2034 # read by uci_stub.sh
SQM_ORDER=(q0 q2 q2b q1 q3 q4 q5)
SQM_COMMITS=0
SQM_LOG=""
: > "${SQM_STUB_DIR}/reloads"
export UCI_CONFIG_DIR="${PWD}/fixtures/uci/sqmmanage"
: > "${PROCD_LOG}"
start_service
assert_contains "manage: managed instance still started" "open m1" "$(cat "${PROCD_LOG}")"
assert_eq "manage: linked queue switched on" "1" "${SQMDB[sqm.q1.enabled]}"
assert_eq "manage: linked queue qdisc -> cake" "cake" "${SQMDB[sqm.q1.qdisc]}"
assert_eq "manage: linked queue script -> piece_of_cake" "piece_of_cake.qos" "${SQMDB[sqm.q1.script]}"
assert_eq "manage + sync: rates synced in the same pass" "30000/10000" "${SQMDB[sqm.q1.download]}/${SQMDB[sqm.q1.upload]}"
assert_eq "manage: auto-detected queue (instance ul_if) switched on" "1" "${SQMDB[sqm.q2.enabled]}"
assert_eq "manage: only the first matching queue is used" "0" "${SQMDB[sqm.q2b.enabled]}"
assert_eq "manage: non-matching queue untouched" "0" "${SQMDB[sqm.q0.enabled]}"
assert_eq "manage: auto-detected queue (global ul_if) switched on" "1" "${SQMDB[sqm.q5.enabled]}"
assert_eq "no manage_sqm: disabled queue left disabled" "0" "${SQMDB[sqm.q3.enabled]}"
assert_eq "no manage_sqm: qdisc untouched" "fq_codel" "${SQMDB[sqm.q3.qdisc]}"
assert_eq "manage: disabled instance switches its queue off" "0" "${SQMDB[sqm.q4.enabled]}"
assert_eq "manage: one commit for all changes" "1" "${SQM_COMMITS}"
assert_eq "manage: one sqm reload" "1" "$(sqm_reloads)"
assert_contains "manage: change logged" "instance 'm1': SQM queue 'q1'" "${SQM_LOG}"
assert_contains "manage: switch-off logged" "instance 'd1': SQM queue 'q4' switched off" "${SQM_LOG}"
start_service
assert_eq "manage: nothing changed -> no commit" "1" "${SQM_COMMITS}"
assert_eq "manage: nothing changed -> no reload" "1" "$(sqm_reloads)"

# rc.common stop(): stop_service "$@"; procd_kill; service_stopped -- SQM goes off only in
# service_stopped, after the instance was killed
SQMDB[sqm.q3.enabled]=1
stop_service m1
assert_eq "stop <id>: nothing switched before procd_kill" "1" "${SQMDB[sqm.q1.enabled]}"
assert_eq "stop <id>: nothing committed before procd_kill" "1" "${SQM_COMMITS}"
service_stopped
assert_eq "stop <id>: its managed queue switched off" "0" "${SQMDB[sqm.q1.enabled]}"
assert_eq "stop <id>: other managed queue stays on" "1" "${SQMDB[sqm.q2.enabled]}"
assert_eq "stop <id>: one commit" "2" "${SQM_COMMITS}"
assert_eq "stop <id>: one reload" "2" "$(sqm_reloads)"
stop_service
assert_eq "full stop: nothing switched before procd_kill" "1" "${SQMDB[sqm.q2.enabled]}"
service_stopped
assert_eq "full stop: managed queue (auto-detected) off" "0" "${SQMDB[sqm.q2.enabled]}"
assert_eq "full stop: managed queue (global ul_if) off" "0" "${SQMDB[sqm.q5.enabled]}"
assert_eq "full stop: unmanaged queue untouched" "1" "${SQMDB[sqm.q3.enabled]}"
assert_eq "full stop: one commit" "3" "${SQM_COMMITS}"
assert_eq "full stop: one reload" "3" "$(sqm_reloads)"
stop_service; service_stopped
assert_eq "stop with nothing to switch off: no commit" "3" "${SQM_COMMITS}"
assert_eq "stop with nothing to switch off: no reload" "3" "$(sqm_reloads)"
stop_service 'x;y'; service_stopped
assert_eq "stop with invalid id: no change" "3" "${SQM_COMMITS}"
stop_service nosuch; service_stopped
assert_eq "stop with unknown id: no change" "3" "${SQM_COMMITS}"

# shutdown (K-script at reboot) must not rewrite the sqm config: boot re-enables anyway
start_service
assert_eq "restart after stop: queue on again" "1" "${SQMDB[sqm.q1.enabled]}"
commits_before=${SQM_COMMITS}
# shellcheck disable=SC2120 # mirrors rc.common's stop(), which forwards its arguments
stop() { stop_service "$@"; service_stopped; }
# never fall through to the host's /sbin/shutdown: only call the init script's own function
if [ "$(type -t shutdown)" = function ]; then shutdown; else fail "shutdown() defined by the init script"; fi
assert_eq "shutdown: queue left on" "1" "${SQMDB[sqm.q1.enabled]}"
assert_eq "shutdown: no commit" "${commits_before}" "${SQM_COMMITS}"
assert_eq "reloads always paired with commits" "${SQM_COMMITS}" "$(sqm_reloads)"
SQM_SHUTDOWN=0

# sqm-lib.sh missing: nothing SQM-related at all (no staged, uncommitted edits)
SQM_LIB_OK=0
SQMDB[sqm.q1.enabled]=0; SQMDB[sqm.q1.download]=1
commits_before=${SQM_COMMITS}
: > "${PROCD_LOG}"
start_service
stop_service; service_stopped
assert_eq "no lib: queue not switched" "0" "${SQMDB[sqm.q1.enabled]}"
assert_eq "no lib: rates not staged" "1" "${SQMDB[sqm.q1.download]}"
assert_eq "no lib: no commit" "${commits_before}" "${SQM_COMMITS}"
assert_contains "no lib: logged" "sqm-lib.sh missing" "${SQM_LOG}"
assert_contains "no lib: instance still started" "open m1" "$(cat "${PROCD_LOG}")"
rm -rf "${SQM_STUB_DIR}"
rm -rf "${cfg_dir}"
rm -rf "${PROCD_LOG}"
report
