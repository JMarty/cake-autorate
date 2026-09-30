#!/usr/bin/env bash

# lib.sh -- common functions for use by cake-autorate.sh
#
# This file is part of cake-autorate.

__set_e=0
if [[ ! ${-} =~ e ]]
then
    set -e
    __set_e=1
fi

if [[ -z ${__sleep_fd:-} ]]
then
	exec {__sleep_fd}<> <(:)
fi

typeof() 
{
	# typeof -- returns the type of a variable

	local type_sig
	type_sig=$(declare -p "${1}" 2>/dev/null)
	if [[ "${type_sig}" =~ "declare --" ]]
	then
		str_type "${1}"
	elif [[ "${type_sig}" =~ "declare -a" ]]
	then
		printf "array"
	elif [[ "${type_sig}" =~ "declare -A" ]]
	then
		printf "map"
	else
		printf "none"
	fi
}

str_type() 
{
	# str_type -- returns the type of a string

	local -n str=${1}

	if [[ "${str}" =~ ^[0-9]+$ ]]
	then
		printf "integer"
	elif [[ "${str}" =~ ^[0-9]*\.[0-9]+$ ]]
	then
		printf "float"
	elif [[ "${str}" =~ ^-[0-9]+$ ]]
	then
		printf "negative-integer"
	elif [[ "${str}" =~ ^-[0-9]*\.[0-9]+$ ]]
	then
		printf "negative-float"
	else
		# technically not validated, user is just trusted to call
		# this function with valid strings
		printf "string"
	fi
}

sleep_s()
{
	# Calling the external sleep binary could be rather slow,
	# especially as it is called very frequently and typically on mediocre hardware.
	#
	# bash's loadable sleep module is not typically available
	# in OpenWRT and most embedded systems, and use of the bash
	# read command with a timeout offers performance that is
	# at least on a par with bash's sleep module.
	#
	# For benchmarks, check the following links:
	# - https://github.com/lynxthecat/cake-autorate/issues/174#issuecomment-1460057382
	# - https://github.com/lynxthecat/cake-autorate/issues/174#issuecomment-1460074498

	# ${1} = sleep_duration_s (seconds, e.g. 0.5, 1 or 1.5)

	read -r -t "${1}" -u "${__sleep_fd}" || :
}

sleep_us()
{
	# ${1} = sleep_duration_us (microseconds)

	printf -v sleep_duration_s %.1f "${1}e-6"
	read -r -t "${sleep_duration_s}" -u "${__sleep_fd}" || :
}

sleep_remaining_tick_time()
{
	# sleeps until the end of the tick duration

	# ${1} = t_start_us (microseconds)
	# ${2} = tick_duration_us (microseconds)

	# shellcheck disable=SC2154
	((
		sleep_duration_us=${1} + ${2} - ${EPOCHREALTIME/.},
		sleep_duration_us < 0 && (sleep_duration_us=0)
	))

	printf -v sleep_duration_s %.1f "${sleep_duration_us}e-6"
	read -r -t "${sleep_duration_s}" -u "${__sleep_fd}" || :
}

randomize_array()
{
	# randomize the order of the elements of an array
	# see: https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle

	local -n array=${1}

	for ((set=${#array[@]}-1; set>0; set--))
	do
		idx=$((RANDOM%(set+1)))
		temp=${array[set]}
		array[set]=${array[idx]}
		array[idx]=${temp}
	done
}

generate_run_token()
{
	local run_token

	read -r run_token < /proc/sys/kernel/random/uuid 2>/dev/null || return 1
	[[ ${run_token} =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || return 1

	printf '%s\n' "${run_token}"
}

running_process_matches_run_token()
{
	local pid=${1} run_token=${2}

	[[ ${pid} =~ ^[0-9]+$ && -n ${run_token} && -r /proc/${pid}/environ ]] || return 1
	tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null | grep -Fxq "CAKE_AUTORATE_RUN_TOKEN=${run_token}"
}

get_running_main_pid_for_run_path()
{
	local run_path=${1} running_main_pid running_run_token

	[[ -f ${run_path}/proc_pids ]] || return 1
	[[ -f ${run_path}/run_token ]] || return 1
	running_main_pid=$(awk -F= '/^main=/ {print $2}' "${run_path}/proc_pids") || return 1
	[[ ${running_main_pid} =~ ^[0-9]+$ && -d /proc/${running_main_pid} ]] || return 1
	read -r running_run_token < "${run_path}/run_token" || return 1
	running_process_matches_run_token "${running_main_pid}" "${running_run_token}" || return 1

	printf '%s\n' "${running_main_pid}"
}

terminate()
{
	# Send regular kill to processes and monitor terminations;
	# return as soon as all of the active processes terminate;
	# if any processes remain active after timeout (defaults to one second),
	# then kill with fire using kill -9;
	# and, finally, call wait on all processes to reap any zombie processes.

	local pids=${1} timeout_ms=${2:-1000}

	read -r -a pids <<< "${pids}"

	kill -TERM -- "${pids[@]}" 2> /dev/null

	for ((i=0; i<timeout_ms; i+=100))
	do
		for process in "${!pids[@]}"
		do
			kill -0 "${pids[${process}]}" 2> /dev/null || unset "pids[${process}]"
		done
		[[ "${pids[*]}" ]] || return
		sleep_s 0.1
	done

	kill -KILL -- "${pids[@]}" 2> /dev/null
}

# fork: JSON helpers for the status file. json_escape_to assigns into a
# variable (no subshell) so writing status.json costs no fork/exec.
json_escape_to()
{
	local -n __out=${1}
	local s=${2//\\/\\\\}
	s=${s//\"/\\\"}
	s=${s//$'\n'/\\n}
	s=${s//$'\r'/\\r}
	__out=${s//$'\t'/\\t}
}

# shellcheck disable=SC2154
# (SC2154: reads main-process globals defined in cake-autorate.sh, which
# sources this file)
build_status_json_to()
{
	# fork: assign a JSON snapshot of this instance to the variable named by $1.
	# Tolerates the arrays that are unset until the first rate/ping update.
	local -n __json=${1}
	local t_now_us=${EPOCHREALTIME/.} state list="" i
	local dl_owd_ms ul_owd_ms dl_thr_ms ul_thr_ms dl_down_ms ul_down_ms
	local e_inst e_ver e_dl e_ul e_pm e_refl
	local head_part dl_part ul_part

	case ${main_state:-RUNNING} in
		IDLE) state=idle ;;
		STALL) state=stall ;;
		*) state=running ;;
	esac

	json_escape_to e_inst "${instance_id}"
	json_escape_to e_ver "${cake_autorate_version}"
	json_escape_to e_dl "${dl_if}"
	json_escape_to e_ul "${ul_if}"
	json_escape_to e_pm "${pinger_method}"

	for ((i=0; i < no_pingers && i < ${#reflectors[@]}; i++))
	do
		json_escape_to e_refl "${reflectors[i]}"
		list+="${list:+,}\"${e_refl}\""
	done

	printf -v dl_owd_ms '%.1f' "${avg_owd_delta_us[DL]:-0}e-3"
	printf -v ul_owd_ms '%.1f' "${avg_owd_delta_us[UL]:-0}e-3"
	printf -v dl_thr_ms '%.1f' "${compensated_owd_delta_delay_thr_us[DL]:-0}e-3"
	printf -v ul_thr_ms '%.1f' "${compensated_owd_delta_delay_thr_us[UL]:-0}e-3"
	printf -v dl_down_ms '%.1f' "${compensated_avg_owd_delta_max_adjust_down_thr_us[DL]:-0}e-3"
	printf -v ul_down_ms '%.1f' "${compensated_avg_owd_delta_max_adjust_down_thr_us[UL]:-0}e-3"

	printf -v head_part '{"instance":"%s","version":"%s","pid":%d,"updated_us":%d,"uptime_s":%d,"state":"%s","dl_if":"%s","ul_if":"%s",' \
		"${e_inst}" "${e_ver}" "${BASHPID}" "${t_now_us}" \
		"$(( (t_now_us - t_process_start_us) / 1000000 ))" "${state}" \
		"${e_dl}" "${e_ul}"
	printf -v dl_part '"dl":{"shaper_kbps":%d,"achieved_kbps":%d,"load":"%s","bufferbloat":%d,"avg_owd_delta_ms":%s,"delay_thr_ms":%s,"max_adjust_down_thr_ms":%s,"sum_delays":%d,"min_kbps":%d,"base_kbps":%d,"max_kbps":%d,"adjust":%d},' \
		"${shaper_rate_kbps[DL]}" "${achieved_rate_kbps[DL]:-0}" "${load_state_name[${load_state[DL]:-0}]}" \
		"${bufferbloat_detected[DL]:-0}" "${dl_owd_ms}" "${dl_thr_ms}" "${dl_down_ms}" "${sum_dl_delays:-0}" \
		"${min_shaper_rate_kbps[DL]}" "${base_shaper_rate_kbps[DL]}" "${max_shaper_rate_kbps[DL]}" "${adjust_shaper_rate[DL]}"
	printf -v ul_part '"ul":{"shaper_kbps":%d,"achieved_kbps":%d,"load":"%s","bufferbloat":%d,"avg_owd_delta_ms":%s,"delay_thr_ms":%s,"max_adjust_down_thr_ms":%s,"sum_delays":%d,"min_kbps":%d,"base_kbps":%d,"max_kbps":%d,"adjust":%d},' \
		"${shaper_rate_kbps[UL]}" "${achieved_rate_kbps[UL]:-0}" "${load_state_name[${load_state[UL]:-0}]}" \
		"${bufferbloat_detected[UL]:-0}" "${ul_owd_ms}" "${ul_thr_ms}" "${ul_down_ms}" "${sum_ul_delays:-0}" \
		"${min_shaper_rate_kbps[UL]}" "${base_shaper_rate_kbps[UL]}" "${max_shaper_rate_kbps[UL]}" "${adjust_shaper_rate[UL]}"
	printf -v __json '%s"pinger_method":"%s","pingers_active":%d,"last_ping_age_ms":%d,%s%s"reflectors":{"active":%d,"list":[%s]}}\n' \
		"${head_part}" "${e_pm}" "${pingers_active:-0}" "$(( (t_now_us - reflectors_last_timestamp_us) / 1000 ))" \
		"${dl_part}" "${ul_part}" "${i}" "${list}"
}

write_status_file()
{
	# fork: written in place with one builtin printf (no tmp+mv fork). The file
	# is < 1 KiB so it lands in one write(); readers retry on an empty/partial
	# read (rpcd do_status).
	local json
	build_status_json_to json
	printf '%s' "${json}" > "${run_path}/status.json"
}

# shellcheck disable=SC2154
# (SC2154: instance_id/dl_if/ul_if are globals from cake-autorate.sh)
write_status_file_waiting()
{
	# Minimal status while waiting for interfaces, before the controller state exists.
	local e_inst e_ver e_dl e_ul
	json_escape_to e_inst "${instance_id}"
	json_escape_to e_ver "${cake_autorate_version}"
	json_escape_to e_dl "${dl_if}"
	json_escape_to e_ul "${ul_if}"
	printf '{"instance":"%s","version":"%s","pid":%d,"updated_us":%d,"state":"waiting_for_if","dl_if":"%s","ul_if":"%s"}\n' \
		"${e_inst}" "${e_ver}" "${BASHPID}" "${EPOCHREALTIME/.}" "${e_dl}" "${e_ul}" > "${run_path}/status.json"
}

# fork: the cross-field checks cake-autorate.sh performs at startup (after
# the --check-config exit point), repeated here so --check-config reports
# them too. Returns the number of violated relations.
# shellcheck disable=SC2154
# (SC2154: reads config globals defined by defaults.sh/the config file)
check_config_relations()
{
	local n=0
	(( min_dl_shaper_rate_kbps < 1 )) && { log_msg "ERROR" "min_dl_shaper_rate_kbps must be at least 1."; ((n++)); }
	(( min_ul_shaper_rate_kbps < 1 )) && { log_msg "ERROR" "min_ul_shaper_rate_kbps must be at least 1."; ((n++)); }
	(( min_dl_shaper_rate_kbps > base_dl_shaper_rate_kbps || base_dl_shaper_rate_kbps > max_dl_shaper_rate_kbps )) && { log_msg "ERROR" "dl shaper rates must satisfy min <= base <= max."; ((n++)); }
	(( min_ul_shaper_rate_kbps > base_ul_shaper_rate_kbps || base_ul_shaper_rate_kbps > max_ul_shaper_rate_kbps )) && { log_msg "ERROR" "ul shaper rates must satisfy min <= base <= max."; ((n++)); }
	[[ ${dl_if} == "${ul_if}" ]] && { log_msg "ERROR" "download interface and upload interface are both set to: '${dl_if}', but cannot be the same."; ((n++)); }
	(( bufferbloat_detection_thr > bufferbloat_detection_window )) && { log_msg "ERROR" "bufferbloat_detection_thr cannot be greater than bufferbloat_detection_window."; ((n++)); }
	(( connection_active_thr_kbps > min_dl_shaper_rate_kbps )) && { log_msg "ERROR" "connection_active_thr_kbps cannot be greater than min_dl_shaper_rate_kbps."; ((n++)); }
	(( connection_active_thr_kbps > min_ul_shaper_rate_kbps )) && { log_msg "ERROR" "connection_active_thr_kbps cannot be greater than min_ul_shaper_rate_kbps."; ((n++)); }
	(( no_pingers < 1 )) && { log_msg "ERROR" "number of pingers must be at least 1."; ((n++)); }
	# (a non-empty reflectors_url appends remote reflectors at startup, so the count is unknown here)
	[[ -z ${reflectors_url:-} ]] && (( no_pingers > ${#reflectors[@]} )) && { log_msg "ERROR" "number of pingers cannot be greater than number of reflectors."; ((n++)); }
	return "${n}"
}

if (( __set_e == 1 ))
then
    set +e
fi
unset __set_e
