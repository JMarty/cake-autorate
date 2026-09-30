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
# --- sync_sqm_rates: uci/logger stubs backed by an associative array ---
declare -A SQMDB=( [sqm.wan]=queue [sqm.wan.download]=1000 [sqm.wan.upload]=2000 [sqm.other]=queue [sqm.other.download]=1 [sqm.other.upload]=2 )
SQM_COMMITS=0
logger() { :; }
uci() {
	[ "$1" = "-q" ] && shift
	case "$1" in
		get) printf '%s' "${SQMDB[$2]:-}"; [ -n "${SQMDB[$2]:-}" ] ;;
		set) SQMDB[${2%%=*}]="${2#*=}" ;;
		commit) SQM_COMMITS=$((SQM_COMMITS + 1)) ;;
	esac
}
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
assert_eq "no sync flag: download untouched" "1" "${SQMDB[sqm.other.download]}"
assert_eq "no sync flag: upload untouched" "2" "${SQMDB[sqm.other.upload]}"
start_service
assert_eq "equal rates: no second commit" "1" "${SQM_COMMITS}"
rm -rf "${cfg_dir}"
rm -rf "${PROCD_LOG}"
report
