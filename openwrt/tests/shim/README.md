functions.sh is an unmodified copy of OpenWrt's /lib/functions.sh (GPL-2.0),
vendored so that uci-to-config.sh, the init scripts and the migration script
can be exercised on a developer machine. openwrt-shim.sh supplies the pieces
that normally come from the uci binary and procd.
