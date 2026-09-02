#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
M="${REPO_ROOT}/openwrt/cake-autorate/files/migrate-legacy-config.sh"
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}"

out=$(bash "${M}" 1 "${PWD}/fixtures/legacy/config.primary.sh"); rc=$?
assert_eq "exit 0" 0 "${rc}"
assert_contains "section" $'set cake-autorate.primary=instance\n' "${out}"
assert_contains "enabled" $'set cake-autorate.primary.enabled=\'1\'\n' "${out}"
assert_contains "changed value" $'set cake-autorate.primary.base_dl_shaper_rate_kbps=\'25000\'\n' "${out}"
assert_contains "float kept" $'set cake-autorate.primary.dl_owd_delta_delay_thr_ms=\'25.0\'\n' "${out}"
assert_contains "spaces quoted" "set cake-autorate.primary.ping_prefix_string='mwan3 use wan exec'" "${out}"
assert_contains "array -> add_list" $'add_list cake-autorate.primary.reflectors=\'1.1.1.1\'\nadd_list cake-autorate.primary.reflectors=\'8.8.8.8\'\n' "${out}"
assert_not_contains "default value omitted" "min_dl_shaper_rate_kbps" "${out}"
assert_not_contains "default flag omitted" "adjust_dl_shaper_rate" "${out}"
assert_contains "changed flag kept" "output_summary_stats='1'" "${out}"

out=$(bash "${M}" 0 /nonexistent/config.x.sh 2>&1); rc=$?
assert_eq "missing file: exit 1" 1 "${rc}"
out=$(bash "${M}" 0 "${PWD}/fixtures/legacy/notaconfig.sh" 2>&1); rc=$?
assert_eq "bad name: exit 1" 1 "${rc}"
report
