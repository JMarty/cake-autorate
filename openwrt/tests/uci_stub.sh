#!/usr/bin/env bash
# In-memory `uci` / `logger` stand-ins for the SQM tests. Source from a test script.
#   SQMDB     associative array "sqm.<sec>[.<opt>]" -> value (declare it before sourcing)
#   SQM_ORDER queue section names in file order (what `uci -X show sqm` lists)
#   SQM_COMMITS  number of `uci commit` calls;  SQM_LOG  accumulated logger lines
#   sqm_reloads  prints how often the recording /etc/init.d/sqm stand-in was run
#                (CAKE_AUTORATE_SQM_INIT is exported: source this BEFORE sqm-lib.sh / the init script)
# shellcheck disable=SC2034 # counters/logs are read by the sourcing test
SQM_COMMITS=0
SQM_LOG=""
SQM_ORDER=()
SQM_STUB_DIR=$(mktemp -d)
: > "${SQM_STUB_DIR}/reloads"
printf '#!/bin/sh\necho "$*" >> "%s/reloads"\n' "${SQM_STUB_DIR}" > "${SQM_STUB_DIR}/sqm"
chmod +x "${SQM_STUB_DIR}/sqm"
export CAKE_AUTORATE_SQM_INIT="${SQM_STUB_DIR}/sqm"
sqm_reloads() { grep -c '^reload$' "${SQM_STUB_DIR}/reloads"; }
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
