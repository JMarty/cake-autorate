#!/usr/bin/env bash
# In-memory `uci` / `logger` stand-ins for the SQM tests. Source from a test script.
#   SQMDB     associative array "sqm.<sec>[.<opt>]" -> value (declare it before sourcing)
#   SQM_ORDER queue section names in file order (what `uci -X show sqm` lists)
#   SQM_COMMITS  number of `uci commit` calls;  SQM_LOG  accumulated logger lines
# shellcheck disable=SC2034 # counters/logs are read by the sourcing test
SQM_COMMITS=0
SQM_LOG=""
SQM_ORDER=()
logger() { SQM_LOG="${SQM_LOG}${*}
"; }
uci() {
	while [ "${1:-}" = "-q" ] || [ "${1:-}" = "-X" ]; do shift; done
	case "$1" in
		get) printf '%s' "${SQMDB[$2]:-}"; [ -n "${SQMDB[$2]:-}" ] ;;
		set) SQMDB[${2%%=*}]="${2#*=}" ;;
		commit) SQM_COMMITS=$((SQM_COMMITS + 1)) ;;
		show)
			[ "$2" = "sqm" ] || return 1
			local s
			for s in "${SQM_ORDER[@]}"; do
				printf 'sqm.%s=%s\n' "${s}" "${SQMDB[sqm.${s}]}"
				printf "sqm.%s.interface='%s'\n" "${s}" "${SQMDB[sqm.${s}.interface]:-}"
			done
			;;
	esac
}
