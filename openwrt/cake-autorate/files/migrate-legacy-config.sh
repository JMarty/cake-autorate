#!/usr/bin/env bash
# migrate-legacy-config.sh -- print `uci batch` commands that recreate legacy
# setup.sh-style config files (config.<id>.sh) as UCI instance sections.
#
# Usage: migrate-legacy-config.sh <enabled 0|1> <config.<id>.sh>...
# Only values that differ from defaults.sh are emitted.
set -u

SCRIPT_PREFIX=${CAKE_AUTORATE_SCRIPT_PREFIX:-/usr/lib/cake-autorate}
enabled=${1:-}
shift || true
case ${enabled} in 0|1) ;; *) printf 'usage: %s <0|1> <config.<id>.sh>...\n' "${0##*/}" >&2; exit 1 ;; esac

mapfile -t valid_keys < <(grep -E '^[^(#| )].*=' "${SCRIPT_PREFIX}/defaults.sh" | sed -e 's/[\t ]*\#.*//g' -e 's/=.*//g')

uci_quote()
{
	# single-quote for uci batch; embedded ' becomes '\''
	printf "'%s'" "${1//\'/\'\\\'\'}"
}

is_array()
{
	[[ $(declare -p "${1}" 2>/dev/null) == "declare -a"* ]]
}

value_of()
{
	# arrays joined with newlines so they compare as one string
	if is_array "${1}"
	then
		local -n __arr=${1}
		printf '%s\n' "${__arr[@]}"
	else
		printf '%s' "${!1}"
	fi
}

emit_instance()
{
	local id=${1} file=${2}
	(
		set +u
		# shellcheck disable=SC1091
		. "${SCRIPT_PREFIX}/defaults.sh"
		declare -A default_value
		local key item
		for key in "${valid_keys[@]}"; do default_value[${key}]=$(value_of "${key}"); done
		# shellcheck disable=SC1090
		. "${file}"
		printf 'set cake-autorate.%s=instance\n' "${id}"
		printf "set cake-autorate.%s.enabled='%s'\n" "${id}" "${enabled}"
		for key in "${valid_keys[@]}"
		do
			[[ $(value_of "${key}") == "${default_value[${key}]}" ]] && continue
			if is_array "${key}"
			then
				local -n __items=${key}
				for item in "${__items[@]}"
				do
					printf 'add_list cake-autorate.%s.%s=%s\n' "${id}" "${key}" "$(uci_quote "${item}")"
				done
			else
				printf 'set cake-autorate.%s.%s=%s\n' "${id}" "${key}" "$(uci_quote "${!key}")"
			fi
		done
	)
}

rc=0
for file in "$@"
do
	if [[ ! -f ${file} ]]
	then
		printf 'migrate: %s: no such file\n' "${file}" >&2; rc=1; continue
	fi
	name=${file##*/}
	if [[ ${name} =~ ^config\.([A-Za-z0-9_]+)\.sh$ ]]
	then
		emit_instance "${BASH_REMATCH[1]}" "${file}"
	else
		printf 'migrate: %s: name is not config.<id>.sh\n' "${file}" >&2; rc=1
	fi
done
exit ${rc}
