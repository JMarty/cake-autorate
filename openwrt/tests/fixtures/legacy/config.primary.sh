#!/usr/bin/env bash
# shellcheck disable=SC2034
dl_if=ifb4wan # download interface
ul_if=wan     # upload interface
adjust_dl_shaper_rate=1
adjust_ul_shaper_rate=1
min_dl_shaper_rate_kbps=5000
base_dl_shaper_rate_kbps=25000
max_dl_shaper_rate_kbps=80000
min_ul_shaper_rate_kbps=5000
base_ul_shaper_rate_kbps=20000
max_ul_shaper_rate_kbps=35000
connection_active_thr_kbps=2000
output_summary_stats=1
reflectors=("1.1.1.1" "8.8.8.8")
ping_prefix_string="mwan3 use wan exec"
dl_owd_delta_delay_thr_ms=25.0
