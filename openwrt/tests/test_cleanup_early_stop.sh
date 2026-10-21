#!/usr/bin/env bash
# shellcheck disable=SC2154 # REPO_ROOT is exported by run-tests.sh
# Issue #1: an exit before the controller section (config error, or a stop while
# verify_ifs_up still waits for the interfaces) runs cleanup_and_killall under
# set -u; it must finish (no "unbound variable", "Stopped" logged, no children left).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}" CAKE_AUTORATE_CONFIG_PREFIX="${REPO_ROOT}"

tmpd=$(mktemp -d)
mkdir -p "${tmpd}/run" "${tmpd}/log" "${tmpd}/bin"
# run a copy whose run dir points into the temp dir (no root needed)
sed "s|/var/run/cake-autorate|${tmpd}/run|g" "${REPO_ROOT}/cake-autorate.sh" > "${tmpd}/cake-autorate.sh"
printf '#!/bin/sh\nsleep 1000\n' > "${tmpd}/bin/fping"
chmod +x "${tmpd}/bin/fping"
export PATH="${tmpd}/bin:${PATH}"

write_config() { # name [extra line]
	cat > "${tmpd}/config.$1.sh" <<-CFG
	dl_if="ca-test-nodl"
	ul_if="ca-test-noul"
	reflectors=("1.1.1.1" "8.8.8.8")
	no_pingers="2"
	log_file_path_override="${tmpd}/log"
	if_up_check_interval_s="0.2"
	${2:-}
	CFG
}

check_cleanup() { # case log
	local out
	out="$(cat "$2" "${tmpd}/stdout.$1" 2>/dev/null)"
	assert_eq "$1: no unbound variable in cleanup" 0 "$(grep -c 'unbound variable' <<< "${out}")"
	assert_eq "$1: cleanup ran to the end" 1 "$(grep -c 'Stopped cake-autorate' <<< "${out}")"
	left=$(pgrep -f "${tmpd}/cake-autorate.sh" | tr '\n' ' ')
	assert_eq "$1: no children left" "" "${left}"
	[[ -n ${left} ]] && kill -KILL ${left} 2>/dev/null
}

# 1) TERM while waiting in verify_ifs_up (procd stop of an instance whose ifb is not up yet)
write_config wait
bash "${tmpd}/cake-autorate.sh" "${tmpd}/config.wait.sh" > "${tmpd}/stdout.wait" 2>&1 &
pid=$!
sleep 3
t_term=${EPOCHREALTIME/.}
kill -TERM "${pid}"
for _ in $(seq 50); do kill -0 "${pid}" 2>/dev/null || break; sleep 0.1; done
if kill -0 "${pid}" 2>/dev/null; then fail "wait: main exited after TERM" "still running"; kill -KILL "${pid}"; else pass "wait: main exited after TERM"; fi
# issue #3: terminate() waited its full timeout on every already exited (zombie) child,
# ~4 s in total, close to procd's term timeout; only the 1 s grace sleep should remain
cleanup_ms=$(( (${EPOCHREALTIME/.} - t_term) / 1000 ))
if (( cleanup_ms < 1700 )); then pass "wait: cleanup finished in ${cleanup_ms} ms (< 1700)"; else fail "wait: cleanup finished in under 1700 ms" "${cleanup_ms} ms"; fi
sleep 1
log="${tmpd}/log/cake-autorate.wait.log"
assert_eq "wait: was stopped inside verify_ifs_up" 1 "$(cat "${log}" "${tmpd}/stdout.wait" 2>/dev/null | grep -c 'Starting: verify_ifs_up')"
check_cleanup wait "${log}"

# 2) config error exits before the controller section
write_config bad 'no_such_setting="1"'
bash "${tmpd}/cake-autorate.sh" "${tmpd}/config.bad.sh" > "${tmpd}/stdout.bad" 2>&1
assert_eq "bad config: exit 1" 1 "$?"
check_cleanup bad "${tmpd}/log/cake-autorate.bad.log"

rm -rf "${tmpd}"
report
