#!/usr/bin/env bash
# shellcheck disable=SC2154 # REPO_ROOT is exported by run-tests.sh
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

out=$(bash "${S}" --check-config "${F}/config.badrates.sh" 2>&1); rc=$?
assert_eq "bad rates: exit 1" 1 "${rc}"
assert_contains "bad rates: message" "min <= base <= max" "${out}"
assert_contains "bad rates: prefix" "ERROR;" "${out}"

out=$(bash "${S}" --check-config "${F}/config.sameif.sh" 2>&1); rc=$?
assert_eq "same if: exit 1" 1 "${rc}"
assert_contains "same if: message" "cannot be the same" "${out}"

out=$(bash "${S}" --check-config "${F}/does-not-exist.sh" 2>&1); rc=$?
assert_eq "missing file: exit 1" 1 "${rc}"
assert_contains "missing file: message" "No config file found" "${out}"
assert_not_contains "no stray stderr" "No such file or directory" "${out}"
# Drift guard: every startup relation message in cake-autorate.sh must also be
# reported by check_config_relations in lib.sh (used by --check-config).
n=0
while IFS= read -r msg
do
	n=$((n+1))
	msg=${msg%"${msg##*[![:space:]]}"}
	if grep -qF -- "log_msg \"ERROR\" \"${msg}" "${REPO_ROOT}/lib.sh"
	then pass "relation in lib.sh: ${msg}"
	else fail "relation missing in lib.sh: ${msg}"
	fi
done < <(sed -n '/keep in sync with check_config_relations/,/Passed error checks/p' "${S}" \
	| sed -n 's/.*log_msg "ERROR" "\(.*\) Exiting script\.".*/\1/p')
[ "${n}" -ge 10 ] && pass "extracted ${n} startup relations" || fail "extracted startup relations" "${n}"
report
