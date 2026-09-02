#!/usr/bin/env bash
# defaults-to-json.sh -- emit defaults.sh as JSON for the LuCI UI:
#   { "<key>": { "value": "<default>", "description": "<inline comment>", "list": bool }, ... }
# Array keys (bash arrays, e.g. reflectors) get list:true and an empty value:
# the UI renders them as DynamicList and never needs the default items inline.
# Only inline comments (text after # on the assignment line) become descriptions.
set -u
file=${1:?usage: defaults-to-json.sh <defaults.sh>}
[[ -f ${file} ]] || { printf 'defaults-to-json: %s: no such file\n' "${file}" >&2; exit 1; }

awk '
function jesc(s) {
	gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\t/, " ", s)
	return s
}
BEGIN { sep = ""; printf "{" }
/^[A-Za-z_]+=\(/ {                                   # array assignment start
	key = $0; sub(/=.*/, "", key)
	printf "%s\"%s\":{\"value\":\"\",\"description\":\"\",\"list\":true}", sep, key
	sep = ","
	next
}
/^[A-Za-z_]+=/ {                                     # scalar assignment
	line = $0
	key = line; sub(/=.*/, "", key)
	val = line; sub(/^[A-Za-z_]+=/, "", val)
	desc = ""
	h = index(val, "#")
	if (h > 0) { desc = substr(val, h + 1); val = substr(val, 1, h - 1) }
	gsub(/^[ \t]+|[ \t]+$/, "", val)
	gsub(/^[ \t]+|[ \t]+$/, "", desc)
	gsub(/^"|"$/, "", val)
	printf "%s\"%s\":{\"value\":\"%s\",\"description\":\"%s\",\"list\":false}", sep, key, jesc(val), jesc(desc)
	sep = ","
	next
}
END { printf "}\n" }
' "${file}"
