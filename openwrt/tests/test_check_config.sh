#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}" CAKE_AUTORATE_CONFIG_PREFIX="${REPO_ROOT}"
S="${REPO_ROOT}/cake-autorate.sh"
F="${PWD}/fixtures/config"

out=$(bash "${S}" --check-config "${F}/config.valid.sh" 2>&1); rc=$?
assert_eq "valid: exit 0" 0 "${rc}"
assert_contains "valid: message" "is valid" "${out}"

out=$(bash "${S}" --check-config "${F}/config.badkey.sh" 2>&1); rc=$?
assert_eq "bad key: exit 1" 1 "${rc}"
assert_contains "bad key: message" "'no_such_setting'" "${out}"
assert_contains "bad key: prefix" "ERROR;" "${out}"

out=$(bash "${S}" --check-config "${F}/config.badtype.sh" 2>&1); rc=$?
assert_eq "bad type: exit 1" 1 "${rc}"
assert_contains "bad type: message" "not a valid value of type: 'integer'" "${out}"

out=$(bash "${S}" --check-config "${F}/does-not-exist.sh" 2>&1); rc=$?
assert_eq "missing file: exit 1" 1 "${rc}"
assert_contains "missing file: message" "No config file found" "${out}"
assert_not_contains "no stray stderr" "No such file or directory" "${out}"
report
