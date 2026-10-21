#!/usr/bin/env bash
# shellcheck disable=SC2154 # REPO_ROOT is exported by run-tests.sh
# lib.sh terminate(): an exited, not yet reaped child counts as terminated (issue #3),
# and a process group (negative pid, irtt pingers) causes no stderr output, which
# intercept_stderr would log as an error and answer by stopping the daemon.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
. "${REPO_ROOT}/lib.sh"
set +e

# 1) a real zombie: the child of a shell that exec'd into sleep is never reaped.
#    The end-to-end timing (zombies inside the cleanup trap) is covered by
#    test_cleanup_early_stop.sh.
zfile=$(mktemp)
# the child must exit after the exec, or bash may still reap it before exec'ing
bash -c 'sleep 0.2 & echo $! > "$1"; exec sleep 3' _ "${zfile}" > /dev/null &
zparent=$!
sleep 0.6
zpid=$(< "${zfile}")
process_is_zombie "${zpid}"; assert_eq "unreaped exited child is a zombie" 0 "$?"
t0=${EPOCHREALTIME/.}
terminate "${zpid}"
ms=$(( (${EPOCHREALTIME/.} - t0) / 1000 ))
if (( ms < 500 )); then pass "zombie: terminate returned in ${ms} ms"; else fail "zombie: terminate returned in under 500 ms" "${ms} ms"; fi
kill -KILL "${zparent}" 2>/dev/null; wait "${zparent}" 2>/dev/null; rm -f "${zfile}"

# 2) a live process group: no stderr, and the group is gone afterwards
set -m
sleep 30 &
gpid=$!
set +m
err=$(terminate "-${gpid}" 2>&1 >/dev/null)
assert_eq "process group: no stderr output" "" "${err}"
if kill -0 "${gpid}" 2>/dev/null && ! process_is_zombie "${gpid}"; then fail "process group: terminated" "still running"; kill -KILL "-${gpid}"; else pass "process group: terminated"; fi
wait "${gpid}" 2>/dev/null

# 3) process_is_zombie: live process and missing pid are not zombies
process_is_zombie "$$"; assert_eq "live process is not a zombie" 1 "$?"
process_is_zombie 999999999; assert_eq "missing pid is not a zombie" 1 "$?"

report
