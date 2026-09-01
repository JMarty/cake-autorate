#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
export UCI_CONFIG_DIR="${PWD}/fixtures/uci/basic"
export PROCD_LOG=$(mktemp)
. ./shim/openwrt-shim.sh

config_load cake-autorate
config_get v wan dl_if
assert_eq "option read" "ifb4wan" "${v}"
config_get_bool e lte enabled 1
assert_eq "bool read" "0" "${e}"
config_get t wan TYPE
assert_eq "section type" "instance" "${t}"
items=""
collect() { items="${items}${items:+,}$1"; }
config_list_foreach wan reflectors collect
assert_eq "list read" "1.1.1.1,8.8.8.8" "${items}"
config_get p wan ping_prefix_string
assert_eq "value with spaces" "mwan3 use wan exec" "${p}"
names=""
each() { names="${names}${names:+,}$1"; }
config_foreach each instance
assert_eq "foreach by type" "wan,lte" "${names}"
procd_open_instance wan
assert_eq "procd stub records" "open wan" "$(cat "${PROCD_LOG}")"
rm -f "${PROCD_LOG}"
report
