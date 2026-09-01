#!/usr/bin/env bash
dl_if="ifb4wan"
ul_if="wan"
min_dl_shaper_rate_kbps="10000"
base_dl_shaper_rate_kbps="30000"
max_dl_shaper_rate_kbps="90000"
reflectors=("1.1.1.1" "8.8.8.8")
ping_prefix_string="mwan3 use wan exec"
dl_owd_delta_delay_thr_ms="25.0"
