#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
export UCI_CONFIG_DIR="${PWD}/fixtures/uci/basic"
export PROCD_LOG=$(mktemp)
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
rm -rf "${cfg_dir}" "${PROCD_LOG}"
report
