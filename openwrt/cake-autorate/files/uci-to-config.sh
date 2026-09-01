#!/usr/bin/env bash
# uci-to-config.sh -- render one cake-autorate instance from UCI into a bash config file.
#
# Usage: uci-to-config.sh <instance-id> [output-path]
#
# Reads /etc/config/cake-autorate. Options of the 'global' section are emitted
# first, then the options of the named 'instance' section (instance wins).
# Option names are the defaults.sh variable names; anything else in the
# section (enabled, sqm_instance, sqm_sync_base_rates) is ignored.
# Keys whose default in defaults.sh is a bash array (reflectors) become arrays;
# they may be given as a UCI list or as a single option.
set -u

SCRIPT_PREFIX=${CAKE_AUTORATE_SCRIPT_PREFIX:-/usr/lib/cake-autorate}
CONFIG_PREFIX=${CAKE_AUTORATE_CONFIG_PREFIX:-/var/etc/cake-autorate}
# shellcheck disable=SC1090
. "${CAKE_AUTORATE_FUNCTIONS_SH:-/lib/functions.sh}"
# OpenWrt's functions.sh is not nounset-safe: config_get/config_list_foreach
# reference an unset $4 (no default given) whenever the section/option being
# looked up doesn't exist, which is the normal case for an unset option or an
# instance without a given list. Disable nounset before using them.
set +u

id=${1:-}
case ${id} in
	''|*[!A-Za-z0-9_]*)
		printf 'uci-to-config: invalid instance id %s\n' "'${id}'" >&2
		exit 1
		;;
	*) ;;
esac
out=${2:-${CONFIG_PREFIX}/config.${id}.sh}

mapfile -t valid_keys < <(grep -E '^[^(#| )].*=' "${SCRIPT_PREFIX}/defaults.sh" | sed -e 's/[\t ]*\#.*//g' -e 's/=.*//g')
mapfile -t array_keys < <(grep -oE '^[A-Za-z_]+=\(' "${SCRIPT_PREFIX}/defaults.sh" | tr -d '=(')

is_array_key()
{
	local k
	for k in "${array_keys[@]}"; do [[ ${k} == "${1}" ]] && return 0; done
	return 1
}

bash_escape()
{
	# make a value safe inside double quotes in a sourced bash file
	local s=${1//\\/\\\\}
	s=${s//\"/\\\"}
	s=${s//\$/\\\$}
	printf '%s' "${s//\`/\\\`}"
}

config_load cake-autorate
config_get section_type "${id}" TYPE
# section_type is assigned by config_get (via eval) in the sourced functions.sh.
# shellcheck disable=SC2154
if [[ ${section_type} != instance ]]
then
	printf 'uci-to-config: no UCI instance section %s\n' "'${id}'" >&2
	exit 1
fi

items=()
collect_item() { items+=("${1}"); }

emit_key()
{
	local key=${1} value section
	if is_array_key "${key}"
	then
		for section in "${id}" global
		do
			items=()
			config_list_foreach "${section}" "${key}" collect_item
			if ((${#items[@]} == 0))
			then
				config_get value "${section}" "${key}"
				[[ -n ${value} ]] && items=("${value}")
			fi
			((${#items[@]})) && break
		done
		((${#items[@]})) || return 0
		local joined="" item
		for item in "${items[@]}"; do joined+="${joined:+ }\"$(bash_escape "${item}")\""; done
		printf '%s=(%s)\n' "${key}" "${joined}"
	else
		config_get value "${id}" "${key}"
		[[ -n ${value} ]] || config_get value global "${key}"
		[[ -n ${value} ]] || return 0
		printf '%s="%s"\n' "${key}" "$(bash_escape "${value}")"
	fi
}

mkdir -p "$(dirname "${out}")"
{
	printf '#!/usr/bin/env bash\n'
	printf '# Generated from UCI (/etc/config/cake-autorate) for instance %s by uci-to-config.sh.\n' "${id}"
	printf '# DO NOT EDIT: this file is rewritten on every service reload. Change UCI (or LuCI) instead.\n\n'
	for key in "${valid_keys[@]}"
	do
		emit_key "${key}"
	done
	printf '\n# end of generated config\n'
} > "${out}.tmp" && mv -f "${out}.tmp" "${out}"
