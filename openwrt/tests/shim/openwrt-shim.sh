# Emulates the OpenWrt runtime pieces our scripts need, on a developer box.
# Usage (from a test): UCI_CONFIG_DIR=<dir> PROCD_LOG=<file> . openwrt-shim.sh
# UCI_CONFIG_DIR holds files in /etc/config syntax named after the package.

IPKG_INSTROOT=""
NO_CALLBACK=""
. "$(dirname "${BASH_SOURCE[0]}")/functions.sh"

package() { return 0; }

# Replaces /lib/config/uci.sh's uci_load: eval the fixture instead of `uci export`.
uci_load() {
	local package="$1"
	[ -f "${UCI_CONFIG_DIR}/${package}" ] || return 1
	CONFIG_SECTIONS=
	CONFIG_NUM_SECTIONS=0
	CONFIG_SECTION=
	eval "$(printf 'package %s\n' "${package}"; cat "${UCI_CONFIG_DIR}/${package}")"
}

# procd stubs: record every call so tests can assert on the instance definitions.
procd_open_instance()      { printf 'open %s\n' "$1" >> "${PROCD_LOG}"; }
procd_set_param()          { printf 'param %s\n' "$*" >> "${PROCD_LOG}"; }
procd_close_instance()     { printf 'close\n' >> "${PROCD_LOG}"; }
procd_add_reload_trigger() { printf 'trigger %s\n' "$*" >> "${PROCD_LOG}"; }
