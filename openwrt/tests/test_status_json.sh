#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
command -v jq >/dev/null || { echo "jq required"; exit 1; }

# Simulate the main process globals, then call the writer from lib.sh.
. "${REPO_ROOT}/lib.sh"
DL=0 UL=1
instance_id=wan cake_autorate_version=3.5.0 pinger_method=fping pingers_active=1 no_pingers=2
dl_if=ifb4wan ul_if=wan main_state=IDLE
load_state_name=(idle low high)
load_state=(2 0)
shaper_rate_kbps=(48200 20000) achieved_rate_kbps=(41000 900)
bufferbloat_detected=(0 1) avg_owd_delta_us=(4200 31000)
compensated_owd_delta_delay_thr_us=(30000 30000)
compensated_avg_owd_delta_max_adjust_down_thr_us=(60000 60000)
sum_dl_delays=0 sum_ul_delays=3
min_shaper_rate_kbps=(5000 5000) base_shaper_rate_kbps=(20000 20000) max_shaper_rate_kbps=(80000 35000)
adjust_shaper_rate=(1 0)
reflectors=("1.1.1.1" "8.8.8.8" "9.9.9.9")
t_process_start_us=$(( ${EPOCHREALTIME/.} - 3612000000 ))
reflectors_last_timestamp_us=$(( ${EPOCHREALTIME/.} - 120000 ))
run_path=$(mktemp -d)

write_status_file
f="${run_path}/status.json"
[ -f "${f}" ] && pass "file written" || fail "file written"
[ -f "${f}.tmp" ] && fail "tmp removed" || pass "tmp removed"
jq -e . "${f}" >/dev/null && pass "valid json" || fail "valid json" "$(cat "${f}")"
assert_eq "instance" "wan" "$(jq -r .instance "${f}")"
assert_eq "state" "idle" "$(jq -r .state "${f}")"
assert_eq "uptime" "3612" "$(jq -r .uptime_s "${f}")"
assert_eq "dl shaper" "48200" "$(jq -r .dl.shaper_kbps "${f}")"
assert_eq "dl load" "high" "$(jq -r .dl.load "${f}")"
assert_eq "ul bufferbloat" "1" "$(jq -r .ul.bufferbloat "${f}")"
assert_eq "dl owd ms" "4.2" "$(jq -r .dl.avg_owd_delta_ms "${f}")"
assert_eq "ul thr ms" "30.0" "$(jq -r .ul.delay_thr_ms "${f}")"
assert_eq "ul adjust" "0" "$(jq -r .ul.adjust "${f}")"
assert_eq "active reflectors" "2" "$(jq -r .reflectors.active "${f}")"
assert_eq "reflector list" "1.1.1.1,8.8.8.8" "$(jq -r '.reflectors.list|join(",")' "${f}")"
assert_eq "ping age" "1" "$(jq -r '(.last_ping_age_ms >= 100 and .last_ping_age_ms < 2000)|if . then 1 else 0 end' "${f}")"

# Before the first SARS/ping the load and delay arrays are unset: must not crash under set -u.
unset load_state bufferbloat_detected sum_dl_delays sum_ul_delays
set -u
write_status_file && pass "unset arrays tolerated" || fail "unset arrays tolerated"
assert_eq "unset load -> idle" "idle" "$(jq -r .dl.load "${f}")"

write_status_file_waiting
assert_eq "waiting state" "waiting_for_if" "$(jq -r .state "${f}")"
rm -rf "${run_path}"
report
