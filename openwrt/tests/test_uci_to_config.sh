#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
C="${REPO_ROOT}/openwrt/cake-autorate/files/uci-to-config.sh"
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}"
export CAKE_AUTORATE_FUNCTIONS_SH="${PWD}/shim/openwrt-shim.sh"
out_dir=$(mktemp -d)
export CAKE_AUTORATE_CONFIG_PREFIX="${out_dir}"

export UCI_CONFIG_DIR="${PWD}/fixtures/uci/basic"
bash "${C}" wan; rc=$?
assert_eq "basic: exit 0" 0 "${rc}"
f="${out_dir}/config.wan.sh"
[ -f "${f}" ] && pass "basic: default output path" || fail "basic: default output path"
c=$(cat "${f}")
assert_contains "basic: header" "DO NOT EDIT" "${c}"
assert_contains "basic: dl_if" $'\ndl_if="ifb4wan"\n' "${c}"
assert_contains "basic: list -> array" $'\nreflectors=("1.1.1.1" "8.8.8.8")\n' "${c}"
assert_contains "basic: spaces kept" $'\nping_prefix_string="mwan3 use wan exec"\n' "${c}"
assert_contains "basic: quotes escaped" $'\nping_extra_args="-I \\"wwan0\\""\n' "${c}"
assert_contains "basic: global merged" $'\nlog_file_max_time_mins="5"\n' "${c}"
assert_contains "basic: instance overrides global" $'\nno_pingers="3"\n' "${c}"
assert_not_contains "basic: enabled filtered" "enabled=" "${c}"
assert_not_contains "basic: sqm_instance filtered" "sqm_instance" "${c}"
[ -f "${f}.tmp" ] && fail "basic: tmp removed" || pass "basic: tmp removed"
out=$(bash "${REPO_ROOT}/cake-autorate.sh" --check-config "${f}" 2>&1); rc=$?
assert_eq "basic: passes --check-config" 0 "${rc}"

bash "${C}" wan "${out_dir}/custom.sh"
[ -f "${out_dir}/custom.sh" ] && pass "explicit output path" || fail "explicit output path"

export UCI_CONFIG_DIR="${PWD}/fixtures/uci/override"
bash "${C}" a
c=$(cat "${out_dir}/config.a.sh")
assert_contains "override: global only key" $'\nlog_to_file="0"\n' "${c}"
assert_contains "override: instance wins" $'\nno_pingers="3"\n' "${c}"
assert_contains "override: single option for array key" $'\nreflectors=("9.9.9.9")\n' "${c}"

err=$(bash "${C}" nosuch 2>&1); rc=$?
assert_eq "missing section: exit 1" 1 "${rc}"
assert_contains "missing section: message" "no UCI instance section 'nosuch'" "${err}"
err=$(bash "${C}" "bad id" 2>&1); rc=$?
assert_eq "bad id: exit 1" 1 "${rc}"
err=$(bash "${C}" 2>&1); rc=$?
assert_eq "no id: exit 1" 1 "${rc}"
rm -rf "${out_dir}"
report
