#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
command -v jq >/dev/null || { echo "jq required"; exit 1; }
P="${REPO_ROOT}/openwrt/cake-autorate/files/defaults-to-json.sh"

out=$(bash "${P}" "${REPO_ROOT}/defaults.sh"); rc=$?
assert_eq "exit 0" 0 "${rc}"
echo "${out}" | jq -e . >/dev/null && pass "valid json" || fail "valid json" "${out:0:200}"
assert_eq "scalar value" "ifb-wan" "$(echo "${out}" | jq -r .dl_if.value)"
assert_eq "float kept" "30.0" "$(echo "${out}" | jq -r .dl_owd_delta_delay_thr_ms.value)"
assert_eq "empty default" "" "$(echo "${out}" | jq -r .ping_prefix_string.value)"
assert_eq "scalar not list" "false" "$(echo "${out}" | jq -r .dl_if.list)"
assert_eq "array is list" "true" "$(echo "${out}" | jq -r .reflectors.list)"
assert_eq "array value empty" "" "$(echo "${out}" | jq -r .reflectors.value)"
assert_contains "description extracted" "download interface" "$(echo "${out}" | jq -r .dl_if.description)"
assert_eq "quotes stripped" "fping" "$(echo "${out}" | jq -r .pinger_method.value)"
assert_eq "key count sane" "true" "$(echo "${out}" | jq '[keys[]] | length > 50' )"
assert_not_contains "no comment-only keys" '"#' "$(echo "${out}" | jq -r 'keys[]' | tr '\n' ' ')"

err=$(bash "${P}" /nonexistent 2>&1); rc=$?
assert_eq "missing file: exit 1" 1 "${rc}"
report
