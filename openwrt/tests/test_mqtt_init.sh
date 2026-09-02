#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
export UCI_CONFIG_DIR="${PWD}/fixtures/uci/mqtt"
export PROCD_LOG=$(mktemp)
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}"
cfg_dir=$(mktemp -d)
export CAKE_AUTORATE_CONFIG_PREFIX="${cfg_dir}"
. ./shim/openwrt-shim.sh
. "${REPO_ROOT}/openwrt/cake-autorate/files/mqtt-publisher.init"
start_service
log=$(cat "${PROCD_LOG}")
assert_contains "command" "param command ${REPO_ROOT}/mqtt-publisher.sh" "${log}"
assert_contains "env" "param env CAKE_AUTORATE_CONFIG_PREFIX=${cfg_dir}" "${log}"
assert_contains "file tracked" "param file ${cfg_dir}/mqtt-publisher.config.sh" "${log}"
assert_contains "unlimited respawn" "param respawn 3600 10 0" "${log}"
c=$(cat "${cfg_dir}/mqtt-publisher.config.sh")
assert_contains "host" $'MQTT_HOST="broker.lan"\n' "${c}"
assert_contains "port" $'MQTT_PORT="1884"\n' "${c}"
# no trailing \n here: MQTT_PASS is the last line of the file, and $(cat ...)
# strips all trailing newlines from command substitution output.
assert_contains "password escaped" 'MQTT_PASS="p\"a\$s"' "${c}"
assert_eq "config mode 600" "600" "$(stat -c %a "${cfg_dir}/mqtt-publisher.config.sh")"
( . "${cfg_dir}/mqtt-publisher.config.sh" && assert_eq "password round-trips" 'p"a$s' "${MQTT_PASS}" )

export UCI_CONFIG_DIR="${PWD}/fixtures/uci/basic"   # mqtt enabled=0 there
: > "${PROCD_LOG}"
start_service
assert_eq "disabled: nothing opened" "" "$(cat "${PROCD_LOG}")"
rm -rf "${cfg_dir}" "${PROCD_LOG}"
report
