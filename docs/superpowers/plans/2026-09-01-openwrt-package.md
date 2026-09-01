# cake-autorate OpenWrt package (plan A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the cake-autorate bash scripts into a proper OpenWrt package with UCI configuration, one procd instance per configured WAN, a machine-readable per-instance status file, an rpcd/ubus backend, legacy-config migration and CI builds — everything the LuCI app (plan B) needs, usable from `ubus`/`service` on its own.

**Architecture:** UCI (`/etc/config/cake-autorate`) is the single source of truth on OpenWrt. `uci-to-config.sh` renders one bash config per instance into `/var/etc/cake-autorate/`; the init script registers one procd instance per enabled section and lets procd restart only the instance whose generated file changed. `cake-autorate.sh` gains a `--check-config` mode and writes `/var/run/cake-autorate/<id>/status.json` once a second. A shell rpcd plugin exposes status, per-instance control, config validation, log operations and SQM/mwan3 discovery over ubus.

**Tech Stack:** bash 5 (scripts), POSIX sh + `/lib/functions.sh` + procd (init, rpcd), `jshn.sh`/`jsonfilter` (JSON in sh), OpenWrt SDK via `openwrt/gh-action-sdk` (CI), shellcheck + jq (tests, run under WSL Ubuntu or any Linux).

**Spec:** `docs/superpowers/specs/2026-09-01-luci-app-and-multi-instance-design.md` (sections 3–9, 12, 13). Plan B (LuCI app) is a separate plan.

## Global Constraints

- Upstream files (`cake-autorate.sh`, `defaults.sh`, `lib.sh`, `setup.sh`, `launcher.sh.template`, `mqtt-publisher.sh`, systemd unit) keep working exactly as today for Asus Merlin / Debian / `setup.sh` users. With `status_file_interval_ms=0` the main script must behave byte-identically to today.
- UCI option names == `defaults.sh` variable names. Extra (non-defaults.sh) instance keys are exactly `enabled`, `sqm_instance`, `sqm_sync_base_rates`; extra section types are `global` and `mqtt`.
- Instance ids match `^[A-Za-z0-9_]+$`.
- Install paths: scripts `/usr/lib/cake-autorate/`, generated configs `/var/etc/cake-autorate/config.<id>.sh`, runtime `/var/run/cake-autorate/<id>/`, logs `/var/log/cake-autorate.<id>.log`.
- Package `cake-autorate`: `PKGARCH:=all`, `DEPENDS:=+bash +fping +sqm-scripts +jsonfilter`, `PKG_VERSION:=3.5.0` (the in-script string `3.3.0-PRERELEASE` is not a valid apk version, so the Makefile hard-codes the CHANGELOG version).
- Every rpcd input is validated (`id` regex + UCI section existence, `action` whitelist, numeric `lines`); never expand user input unquoted.
- `.gitignore` in this repo ignores `[a-z].sh`, `[a-z][a-z].sh`, `[a-z][a-z][a-z].sh` — **never create a new shell file whose basename is 1–3 letters** (e.g. `run.sh`, `lib.sh`); use longer names.
- Tests run with `bash openwrt/tests/run-tests.sh` under WSL Ubuntu (`wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && bash openwrt/tests/run-tests.sh'`). One-time setup in WSL: `sudo apt-get install -y shellcheck jq`.
- Commit after every task on branch `feature/luci-app-multi-instance`; commit messages end with the `Co-Authored-By`/`Claude-Session` trailers used in this repo's previous commit.

---

## File map

| Path | Responsibility |
|---|---|
| `openwrt/tests/run-tests.sh` | runs every `openwrt/tests/test_*.sh`, exit 1 if any fails |
| `openwrt/tests/assert.sh` | tiny assertion helpers (`assert_eq`, `assert_contains`, `report`) |
| `openwrt/tests/shim/functions.sh` | verbatim copy of OpenWrt `/lib/functions.sh` (GPL-2, test only) |
| `openwrt/tests/shim/openwrt-shim.sh` | sources functions.sh, provides `uci_load` from fixture files + recording stubs for `procd_*` |
| `openwrt/tests/fixtures/…` | UCI and legacy config fixtures |
| `defaults.sh` | + `status_file_interval_ms` |
| `lib.sh` | + `build_status_json`, `write_status_file`, `write_status_file_waiting` |
| `cake-autorate.sh` | + `--check-config`, status-file hooks, cleanup guard |
| `openwrt/cake-autorate/files/uci-to-config.sh` | UCI section → bash config file |
| `openwrt/cake-autorate/files/migrate-legacy-config.sh` | legacy `config.<id>.sh` → `uci batch` commands |
| `openwrt/cake-autorate/files/cake-autorate.defaults` | uci-defaults: run migration once, stop legacy launcher, reload rpcd |
| `openwrt/cake-autorate/files/cake-autorate.init` | procd init, one instance per enabled section |
| `openwrt/cake-autorate/files/mqtt-publisher.init` | procd init for the MQTT publisher from the `mqtt` UCI section |
| `openwrt/cake-autorate/files/cake-autorate.config` | default `/etc/config/cake-autorate` |
| `openwrt/cake-autorate/files/rpcd-cake-autorate` | rpcd plugin, ubus object `cake-autorate` |
| `openwrt/cake-autorate/Makefile` | package definition |
| `openwrt/tests/router/smoke.sh` | on-router integration checks (run over SSH) |
| `.github/workflows/openwrt-packages.yml` | shellcheck + unit tests + SDK builds |

---

### Task 1: Test harness and OpenWrt shim

**Files:**
- Create: `openwrt/tests/run-tests.sh`
- Create: `openwrt/tests/assert.sh`
- Create: `openwrt/tests/shim/functions.sh` (downloaded)
- Create: `openwrt/tests/shim/openwrt-shim.sh`
- Create: `openwrt/tests/fixtures/uci/basic/cake-autorate`
- Test: `openwrt/tests/test_shim.sh`

**Interfaces:**
- Produces: `assert_eq NAME EXPECTED ACTUAL`, `assert_contains NAME NEEDLE HAYSTACK`, `assert_not_contains NAME NEEDLE HAYSTACK`, `report` (exit 0 iff no failures); env `REPO_ROOT` exported by the runner; shim env `UCI_CONFIG_DIR` (directory holding UCI-syntax files named after the package); stubs `procd_open_instance`, `procd_set_param`, `procd_close_instance`, `procd_add_reload_trigger` that append one line each to `$PROCD_LOG`.

- [ ] **Step 1: Write the assertion helpers**

`openwrt/tests/assert.sh`:

```bash
# Assertion helpers for cake-autorate OpenWrt tests. Source from a test script.
TESTS_RUN=0
TESTS_FAILED=0

pass() { TESTS_RUN=$((TESTS_RUN + 1)); printf 'ok   - %s\n' "$1"; }

fail() {
	TESTS_RUN=$((TESTS_RUN + 1)); TESTS_FAILED=$((TESTS_FAILED + 1))
	printf 'FAIL - %s\n' "$1"
	[ -n "${2:-}" ] && printf '       %s\n' "$2"
}

assert_eq() { # name expected actual
	if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected: [$2] got: [$3]"; fi
}

assert_contains() { # name needle haystack
	case "$3" in *"$2"*) pass "$1" ;; *) fail "$1" "missing: [$2] in: [$3]" ;; esac
}

assert_not_contains() { # name needle haystack
	case "$3" in *"$2"*) fail "$1" "unexpected: [$2] in: [$3]" ;; *) pass "$1" ;; esac
}

report() {
	printf '%d tests, %d failed\n' "$TESTS_RUN" "$TESTS_FAILED"
	[ "$TESTS_FAILED" -eq 0 ]
}
```

- [ ] **Step 2: Write the runner**

`openwrt/tests/run-tests.sh`:

```bash
#!/usr/bin/env bash
# Runs every openwrt/tests/test_*.sh. Exit status 1 if any test script fails.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
REPO_ROOT=$(cd ../.. && pwd)
export REPO_ROOT
rc=0
for t in test_*.sh
do
	printf '== %s\n' "${t}"
	bash "${t}" || rc=1
done
exit ${rc}
```

- [ ] **Step 3: Vendor OpenWrt's functions.sh**

```bash
mkdir -p "openwrt/tests/shim"
curl -fsSL https://raw.githubusercontent.com/openwrt/openwrt/main/package/base-files/files/lib/functions.sh \
  -o openwrt/tests/shim/functions.sh
head -3 openwrt/tests/shim/functions.sh
```
Expected: the file starts with `#!/bin/sh` and a `# Copyright (C) 2006-2014 OpenWrt.org` line. Prepend nothing; add a note in `openwrt/tests/shim/README.md`:

```
functions.sh is an unmodified copy of OpenWrt's /lib/functions.sh (GPL-2.0),
vendored so that uci-to-config.sh, the init scripts and the migration script
can be exercised on a developer machine. openwrt-shim.sh supplies the pieces
that normally come from the uci binary and procd.
```

- [ ] **Step 4: Write the shim**

`openwrt/tests/shim/openwrt-shim.sh`:

```bash
# Emulates the OpenWrt runtime pieces our scripts need, on a developer box.
# Usage (from a test): UCI_CONFIG_DIR=<dir> PROCD_LOG=<file> . openwrt-shim.sh
# UCI_CONFIG_DIR holds files in /etc/config syntax named after the package.

unset IPKG_INSTROOT
. "$(dirname "${BASH_SOURCE[0]}")/functions.sh"

package() { return 0; }

# Replaces /lib/config/uci.sh's uci_load: eval the fixture instead of `uci export`.
uci_load() {
	local package="$1"
	[ -f "${UCI_CONFIG_DIR}/${package}" ] || return 1
	eval "$(printf 'package %s\n' "${package}"; cat "${UCI_CONFIG_DIR}/${package}")"
}

# procd stubs: record every call so tests can assert on the instance definitions.
procd_open_instance()      { printf 'open %s\n' "$1" >> "${PROCD_LOG}"; }
procd_set_param()          { printf 'param %s\n' "$*" >> "${PROCD_LOG}"; }
procd_close_instance()     { printf 'close\n' >> "${PROCD_LOG}"; }
procd_add_reload_trigger() { printf 'trigger %s\n' "$*" >> "${PROCD_LOG}"; }
```

- [ ] **Step 5: Write the fixture**

`openwrt/tests/fixtures/uci/basic/cake-autorate`:

```
config global 'global'
	option log_file_max_time_mins '5'
	option no_pingers '4'

config instance 'wan'
	option enabled '1'
	option sqm_instance 'wan'
	option dl_if 'ifb4wan'
	option ul_if 'wan'
	option min_dl_shaper_rate_kbps '10000'
	option base_dl_shaper_rate_kbps '30000'
	option max_dl_shaper_rate_kbps '90000'
	option no_pingers '3'
	option ping_prefix_string 'mwan3 use wan exec'
	option ping_extra_args '-I "wwan0"'
	list reflectors '1.1.1.1'
	list reflectors '8.8.8.8'

config instance 'lte'
	option enabled '0'
	option dl_if 'ifb4wwan0'
	option ul_if 'wwan0'

config mqtt 'mqtt'
	option enabled '0'
	option port '1883'
```

- [ ] **Step 6: Write the shim test**

`openwrt/tests/test_shim.sh`:

```bash
#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
export UCI_CONFIG_DIR="${PWD}/fixtures/uci/basic"
export PROCD_LOG=$(mktemp)
. ./shim/openwrt-shim.sh

config_load cake-autorate
config_get v wan dl_if
assert_eq "option read" "ifb4wan" "${v}"
config_get_bool e lte enabled 1
assert_eq "bool read" "0" "${e}"
config_get t wan TYPE
assert_eq "section type" "instance" "${t}"
items=""
collect() { items="${items}${items:+,}$1"; }
config_list_foreach wan reflectors collect
assert_eq "list read" "1.1.1.1,8.8.8.8" "${items}"
config_get p wan ping_prefix_string
assert_eq "value with spaces" "mwan3 use wan exec" "${p}"
names=""
each() { names="${names}${names:+,}$1"; }
config_foreach each instance
assert_eq "foreach by type" "wan,lte" "${names}"
procd_open_instance wan
assert_eq "procd stub records" "open wan" "$(cat "${PROCD_LOG}")"
rm -f "${PROCD_LOG}"
report
```

- [ ] **Step 7: Run the tests**

Run (WSL): `wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && bash openwrt/tests/run-tests.sh'`
Expected: `== test_shim.sh`, seven `ok` lines, `7 tests, 0 failed`, exit 0.

- [ ] **Step 8: Commit**

```bash
git add openwrt/tests
git commit -m "Add OpenWrt test harness with functions.sh shim"
```

---

### Task 2: `--check-config` mode and cleanup guard in `cake-autorate.sh`

**Files:**
- Modify: `cake-autorate.sh` (cleanup at ~line 124; argument handling ~lines 966–1000; validation exit ~lines 1037–1042)
- Create: `openwrt/tests/fixtures/config/config.valid.sh`, `config.badkey.sh`, `config.badtype.sh`
- Test: `openwrt/tests/test_check_config.sh`

**Interfaces:**
- Produces: `cake-autorate.sh --check-config <path>` → exit 0 and prints `Config file <path> is valid.`; exit 1 and prints one `ERROR; <date>; <ts>; <message>` line per problem. Never writes to `/var/log`, never creates `/var/run/cake-autorate`.

- [ ] **Step 1: Write the fixtures**

`openwrt/tests/fixtures/config/config.valid.sh`:
```bash
#!/usr/bin/env bash
dl_if="ifb4wan"
ul_if="wan"
min_dl_shaper_rate_kbps="10000"
base_dl_shaper_rate_kbps="30000"
max_dl_shaper_rate_kbps="90000"
reflectors=("1.1.1.1" "8.8.8.8")
ping_prefix_string="mwan3 use wan exec"
dl_owd_delta_delay_thr_ms="25.0"
```
`config.badkey.sh`:
```bash
#!/usr/bin/env bash
dl_if="ifb4wan"
no_such_setting="1"
```
`config.badtype.sh`:
```bash
#!/usr/bin/env bash
min_dl_shaper_rate_kbps="fast"
```

- [ ] **Step 2: Write the failing test**

`openwrt/tests/test_check_config.sh`:
```bash
#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}" CAKE_AUTORATE_CONFIG_PREFIX="${REPO_ROOT}"
S="${REPO_ROOT}/cake-autorate.sh"
F="${PWD}/fixtures/config"

out=$(bash "${S}" --check-config "${F}/config.valid.sh" 2>&1); rc=$?
assert_eq "valid: exit 0" 0 "${rc}"
assert_contains "valid: message" "is valid" "${out}"

out=$(bash "${S}" --check-config "${F}/config.badkey.sh" 2>&1); rc=$?
assert_eq "bad key: exit 1" 1 "${rc}"
assert_contains "bad key: message" "'no_such_setting'" "${out}"
assert_contains "bad key: prefix" "ERROR;" "${out}"

out=$(bash "${S}" --check-config "${F}/config.badtype.sh" 2>&1); rc=$?
assert_eq "bad type: exit 1" 1 "${rc}"
assert_contains "bad type: message" "not a valid value of type: 'integer'" "${out}"

out=$(bash "${S}" --check-config "${F}/does-not-exist.sh" 2>&1); rc=$?
assert_eq "missing file: exit 1" 1 "${rc}"
assert_contains "missing file: message" "No config file found" "${out}"
assert_not_contains "no stray stderr" "No such file or directory" "${out}"
report
```

- [ ] **Step 3: Run test to verify it fails**

Run: `wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && bash openwrt/tests/test_check_config.sh'`
Expected: FAIL lines (the script treats `--check-config` as a config path today and prints `No config file found`; "valid: exit 0" fails).

- [ ] **Step 4: Implement**

(a) In `cleanup_and_killall`, replace
```bash
	[[ -d ${run_path} ]] && rm -r "${run_path}"
```
with
```bash
	# Only remove the per-instance run dir; before instance_id is known run_path is the shared parent.
	[[ -n ${instance_id:-} && -d ${run_path} ]] && rm -r "${run_path}"
```

(b) Directly after the line `((systemd_service)) && use_logger=0` insert:
```bash
# --check-config <path>: validate the config file, print problems, exit 0/1.
# Nothing is started, no run dir or log file is created.
check_config_only=0
if [[ ${1-} == "--check-config" ]]
then
	check_config_only=1
	shift
	log_to_file=0 print_to_stdout=1 use_logger=0
	trap - INT TERM EXIT
fi
```

(c) Directly after the line `unset valid_config_entries user_config config_error_count key` insert:
```bash
if ((check_config_only))
then
	printf 'Config file %s is valid.\n' "${config_path}"
	exit 0
fi
```

- [ ] **Step 5: Run test to verify it passes**

Run the same command. Expected: `10 tests, 0 failed`.

- [ ] **Step 6: Confirm shellcheck is clean on the change**

Run: `wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && shellcheck -x cake-autorate.sh; echo rc=$?'`
Expected: same warnings as before the change (compare with `git stash; shellcheck -x cake-autorate.sh; git stash pop`), no new ones.

- [ ] **Step 7: Commit**

```bash
git add cake-autorate.sh openwrt/tests/fixtures/config openwrt/tests/test_check_config.sh
git commit -m "Add --check-config mode and guard shared run dir in cleanup"
```

---

### Task 3: Per-instance `status.json`

**Files:**
- Modify: `defaults.sh` (advanced options block)
- Modify: `lib.sh` (append functions before the trailing `set +e` block)
- Modify: `cake-autorate.sh` (`verify_ifs_up`; timing init ~line 1285; state init ~lines 1425–1436; after `Started cake-autorate` log; end of main loop before `done`)
- Test: `openwrt/tests/test_status_json.sh`

**Interfaces:**
- Produces: `build_status_json` (prints JSON from main-process globals), `write_status_file` (atomic write to `${run_path}/status.json`), `write_status_file_waiting` (minimal JSON with `state: waiting_for_if`). JSON keys exactly as in spec §6a: `instance, version, pid, uptime_s, state, dl_if, ul_if, pinger_method, pingers_active, last_ping_age_ms, dl{shaper_kbps, achieved_kbps, load, bufferbloat, avg_owd_delta_ms, delay_thr_ms, max_adjust_down_thr_ms, sum_delays, min_kbps, base_kbps, max_kbps, adjust}, ul{same}, reflectors{active, list[]}`.

- [ ] **Step 1: Write the failing test**

`openwrt/tests/test_status_json.sh`:
```bash
#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
command -v jq >/dev/null || { echo "jq required"; exit 1; }

# Simulate the main process globals, then call the writer from lib.sh.
. "${REPO_ROOT}/lib.sh"
DL=0 UL=1
instance_id=wan cake_autorate_version=3.5.0 pinger_method=fping pingers_active=1 no_pingers=2
dl_if=ifb4wan ul_if=wan main_state=IDLE
load_state_name=(idle low high)
load_state=(2 0)
shaper_rate_kbps=(48200 20000) achieved_rate_kbps=(41000 900)
bufferbloat_detected=(0 1) avg_owd_delta_us=(4200 31000)
compensated_owd_delta_delay_thr_us=(30000 30000)
compensated_avg_owd_delta_max_adjust_down_thr_us=(60000 60000)
sum_dl_delays=0 sum_ul_delays=3
min_shaper_rate_kbps=(5000 5000) base_shaper_rate_kbps=(20000 20000) max_shaper_rate_kbps=(80000 35000)
adjust_shaper_rate=(1 0)
reflectors=("1.1.1.1" "8.8.8.8" "9.9.9.9")
t_process_start_us=$(( ${EPOCHREALTIME/.} - 3612000000 ))
reflectors_last_timestamp_us=$(( ${EPOCHREALTIME/.} - 120000 ))
run_path=$(mktemp -d)

write_status_file
f="${run_path}/status.json"
[ -f "${f}" ] && pass "file written" || fail "file written"
[ -f "${f}.tmp" ] && fail "tmp removed" || pass "tmp removed"
jq -e . "${f}" >/dev/null && pass "valid json" || fail "valid json" "$(cat "${f}")"
assert_eq "instance" "wan" "$(jq -r .instance "${f}")"
assert_eq "state" "idle" "$(jq -r .state "${f}")"
assert_eq "uptime" "3612" "$(jq -r .uptime_s "${f}")"
assert_eq "dl shaper" "48200" "$(jq -r .dl.shaper_kbps "${f}")"
assert_eq "dl load" "high" "$(jq -r .dl.load "${f}")"
assert_eq "ul bufferbloat" "1" "$(jq -r .ul.bufferbloat "${f}")"
assert_eq "dl owd ms" "4.2" "$(jq -r .dl.avg_owd_delta_ms "${f}")"
assert_eq "ul thr ms" "30.0" "$(jq -r .ul.delay_thr_ms "${f}")"
assert_eq "ul adjust" "0" "$(jq -r .ul.adjust "${f}")"
assert_eq "active reflectors" "2" "$(jq -r .reflectors.active "${f}")"
assert_eq "reflector list" "1.1.1.1,8.8.8.8" "$(jq -r '.reflectors.list|join(",")' "${f}")"
assert_eq "ping age" "1" "$(jq -r '(.last_ping_age_ms >= 100 and .last_ping_age_ms < 2000)|if . then 1 else 0 end' "${f}")"

# Before the first SARS/ping the load and delay arrays are unset: must not crash under set -u.
unset load_state bufferbloat_detected sum_dl_delays sum_ul_delays
set -u
write_status_file && pass "unset arrays tolerated" || fail "unset arrays tolerated"
assert_eq "unset load -> idle" "idle" "$(jq -r .dl.load "${f}")"

write_status_file_waiting
assert_eq "waiting state" "waiting_for_if" "$(jq -r .state "${f}")"
rm -rf "${run_path}"
report
```

- [ ] **Step 2: Run test to verify it fails**

Run: `wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && bash openwrt/tests/test_status_json.sh'`
Expected: fails with `write_status_file: command not found`.

- [ ] **Step 3: Add the default**

In `defaults.sh`, after the `log_file_export_compress=1` line add:
```bash
# interval in ms between writes of the per-instance status snapshot
# (${run_path}/status.json, read by the LuCI app); 0 disables the status file
status_file_interval_ms=1000
```

- [ ] **Step 4: Add the functions to `lib.sh`**

Insert before the final `if (( __set_e == 1 ))` block:
```bash
json_escape()
{
	# escape backslash and double quote for embedding in a JSON string
	local s=${1//\\/\\\\}
	printf '%s' "${s//\"/\\\"}"
}

build_status_json()
{
	# Print a JSON snapshot of this instance from the main process globals.
	# Tolerates the arrays that are unset until the first rate/ping update.
	local t_now_us=${EPOCHREALTIME/.} state list="" i
	local dl_owd_ms ul_owd_ms dl_thr_ms ul_thr_ms dl_down_ms ul_down_ms

	case ${main_state:-RUNNING} in
		IDLE) state=idle ;;
		STALL) state=stall ;;
		*) state=running ;;
	esac

	for ((i=0; i < no_pingers && i < ${#reflectors[@]}; i++))
	do
		list+="${list:+,}\"$(json_escape "${reflectors[i]}")\""
	done

	printf -v dl_owd_ms '%.1f' "${avg_owd_delta_us[DL]:-0}e-3"
	printf -v ul_owd_ms '%.1f' "${avg_owd_delta_us[UL]:-0}e-3"
	printf -v dl_thr_ms '%.1f' "${compensated_owd_delta_delay_thr_us[DL]:-0}e-3"
	printf -v ul_thr_ms '%.1f' "${compensated_owd_delta_delay_thr_us[UL]:-0}e-3"
	printf -v dl_down_ms '%.1f' "${compensated_avg_owd_delta_max_adjust_down_thr_us[DL]:-0}e-3"
	printf -v ul_down_ms '%.1f' "${compensated_avg_owd_delta_max_adjust_down_thr_us[UL]:-0}e-3"

	printf '{"instance":"%s","version":"%s","pid":%d,"uptime_s":%d,"state":"%s","dl_if":"%s","ul_if":"%s",' \
		"$(json_escape "${instance_id}")" "$(json_escape "${cake_autorate_version}")" "${BASHPID}" \
		"$(( (t_now_us - t_process_start_us) / 1000000 ))" "${state}" \
		"$(json_escape "${dl_if}")" "$(json_escape "${ul_if}")"
	printf '"pinger_method":"%s","pingers_active":%d,"last_ping_age_ms":%d,' \
		"$(json_escape "${pinger_method}")" "${pingers_active:-0}" "$(( (t_now_us - reflectors_last_timestamp_us) / 1000 ))"
	printf '"dl":{"shaper_kbps":%d,"achieved_kbps":%d,"load":"%s","bufferbloat":%d,"avg_owd_delta_ms":%s,"delay_thr_ms":%s,"max_adjust_down_thr_ms":%s,"sum_delays":%d,"min_kbps":%d,"base_kbps":%d,"max_kbps":%d,"adjust":%d},' \
		"${shaper_rate_kbps[DL]}" "${achieved_rate_kbps[DL]:-0}" "${load_state_name[${load_state[DL]:-0}]}" \
		"${bufferbloat_detected[DL]:-0}" "${dl_owd_ms}" "${dl_thr_ms}" "${dl_down_ms}" "${sum_dl_delays:-0}" \
		"${min_shaper_rate_kbps[DL]}" "${base_shaper_rate_kbps[DL]}" "${max_shaper_rate_kbps[DL]}" "${adjust_shaper_rate[DL]}"
	printf '"ul":{"shaper_kbps":%d,"achieved_kbps":%d,"load":"%s","bufferbloat":%d,"avg_owd_delta_ms":%s,"delay_thr_ms":%s,"max_adjust_down_thr_ms":%s,"sum_delays":%d,"min_kbps":%d,"base_kbps":%d,"max_kbps":%d,"adjust":%d},' \
		"${shaper_rate_kbps[UL]}" "${achieved_rate_kbps[UL]:-0}" "${load_state_name[${load_state[UL]:-0}]}" \
		"${bufferbloat_detected[UL]:-0}" "${ul_owd_ms}" "${ul_thr_ms}" "${ul_down_ms}" "${sum_ul_delays:-0}" \
		"${min_shaper_rate_kbps[UL]}" "${base_shaper_rate_kbps[UL]}" "${max_shaper_rate_kbps[UL]}" "${adjust_shaper_rate[UL]}"
	printf '"reflectors":{"active":%d,"list":[%s]}}\n' "${i}" "${list}"
}

write_status_file()
{
	# Atomically replace ${run_path}/status.json (readers never see a partial file).
	build_status_json > "${run_path}/status.json.tmp" && mv -f "${run_path}/status.json.tmp" "${run_path}/status.json"
}

write_status_file_waiting()
{
	# Minimal status while waiting for interfaces, before the controller state exists.
	printf '{"instance":"%s","version":"%s","pid":%d,"state":"waiting_for_if","dl_if":"%s","ul_if":"%s"}\n' \
		"$(json_escape "${instance_id}")" "$(json_escape "${cake_autorate_version}")" "${BASHPID}" \
		"$(json_escape "${dl_if}")" "$(json_escape "${ul_if}")" > "${run_path}/status.json.tmp" \
		&& mv -f "${run_path}/status.json.tmp" "${run_path}/status.json"
}
```

- [ ] **Step 5: Run test to verify it passes**

Run the same command. Expected: `19 tests, 0 failed`.

- [ ] **Step 6: Hook the writer into `cake-autorate.sh`**

(a) In `verify_ifs_up`, inside the `while` loop after the two `log_msg` lines add:
```bash
		(( status_file_interval_ms > 0 )) && write_status_file_waiting
```

(b) After the line `printf -v reflector_health_check_interval_us %.0f "${reflector_health_check_interval_s}e6"` add:
```bash
printf -v status_file_interval_us %.0f "${status_file_interval_ms}e3"
```

(c) In the timer initialisation block that starts with `t_start_us=${EPOCHREALTIME/.} \`, add to the same continued assignment (before `pingers_t_start_us=`):
```bash
t_process_start_us=${t_start_us} t_last_status_file_write_us=0 \
```

(d) After `log_msg "INFO" "Started cake-autorate with PID: ${BASHPID} and config: ${config_path}"` add:
```bash
(( status_file_interval_us > 0 )) && write_status_file
```

(e) At the end of the main `while :` loop body, immediately before the final `done`, add:
```bash
	if (( status_file_interval_us > 0 && t_start_us > t_last_status_file_write_us + status_file_interval_us ))
	then
		write_status_file
		t_last_status_file_write_us=${t_start_us}
	fi
```

- [ ] **Step 7: Verify syntax, shellcheck and the check-config regression**

Run: `wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && bash -n cake-autorate.sh && shellcheck -x cake-autorate.sh lib.sh; bash openwrt/tests/run-tests.sh'`
Expected: no new shellcheck findings; all test scripts pass.

- [ ] **Step 8: Commit**

```bash
git add defaults.sh lib.sh cake-autorate.sh openwrt/tests/test_status_json.sh
git commit -m "Write per-instance status.json for UI consumers"
```

---

### Task 4: `uci-to-config.sh`

**Files:**
- Create: `openwrt/cake-autorate/files/uci-to-config.sh`
- Create: `openwrt/tests/fixtures/uci/override/cake-autorate`
- Test: `openwrt/tests/test_uci_to_config.sh`

**Interfaces:**
- Consumes: `/lib/functions.sh` (`config_load`, `config_get`, `config_list_foreach`), env `CAKE_AUTORATE_SCRIPT_PREFIX` (default `/usr/lib/cake-autorate`), `CAKE_AUTORATE_CONFIG_PREFIX` (default `/var/etc/cake-autorate`), `CAKE_AUTORATE_FUNCTIONS_SH` (default `/lib/functions.sh`; tests point it at the shim).
- Produces: `uci-to-config.sh <id> [output-path]` → writes `${CONFIG_PREFIX}/config.<id>.sh` (or `output-path`) atomically; exit 1 with a message on stderr for an invalid/missing id.

- [ ] **Step 1: Write the fixture**

`openwrt/tests/fixtures/uci/override/cake-autorate`:
```
config global 'global'
	option no_pingers '4'
	option log_to_file '0'

config instance 'a'
	option enabled '1'
	option dl_if 'ifb4a'
	option ul_if 'a'
	option no_pingers '3'
	option reflectors '9.9.9.9'
```

- [ ] **Step 2: Write the failing test**

`openwrt/tests/test_uci_to_config.sh`:
```bash
#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
C="${REPO_ROOT}/openwrt/cake-autorate/files/uci-to-config.sh"
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}"
export CAKE_AUTORATE_FUNCTIONS_SH="${PWD}/shim/openwrt-shim.sh"
out_dir=$(mktemp -d)
export CAKE_AUTORATE_CONFIG_PREFIX="${out_dir}"

export UCI_CONFIG_DIR="${PWD}/fixtures/uci/basic"
bash "${C}" wan; rc=$?
assert_eq "basic: exit 0" 0 "${rc}"
f="${out_dir}/config.wan.sh"
[ -f "${f}" ] && pass "basic: default output path" || fail "basic: default output path"
c=$(cat "${f}")
assert_contains "basic: header" "DO NOT EDIT" "${c}"
assert_contains "basic: dl_if" $'\ndl_if="ifb4wan"\n' "${c}"
assert_contains "basic: list -> array" $'\nreflectors=("1.1.1.1" "8.8.8.8")\n' "${c}"
assert_contains "basic: spaces kept" $'\nping_prefix_string="mwan3 use wan exec"\n' "${c}"
assert_contains "basic: quotes escaped" $'\nping_extra_args="-I \\"wwan0\\""\n' "${c}"
assert_contains "basic: global merged" $'\nlog_file_max_time_mins="5"\n' "${c}"
assert_contains "basic: instance overrides global" $'\nno_pingers="3"\n' "${c}"
assert_not_contains "basic: enabled filtered" "enabled=" "${c}"
assert_not_contains "basic: sqm_instance filtered" "sqm_instance" "${c}"
[ -f "${f}.tmp" ] && fail "basic: tmp removed" || pass "basic: tmp removed"
out=$(bash "${REPO_ROOT}/cake-autorate.sh" --check-config "${f}" 2>&1); rc=$?
assert_eq "basic: passes --check-config" 0 "${rc}"

bash "${C}" wan "${out_dir}/custom.sh"
[ -f "${out_dir}/custom.sh" ] && pass "explicit output path" || fail "explicit output path"

export UCI_CONFIG_DIR="${PWD}/fixtures/uci/override"
bash "${C}" a
c=$(cat "${out_dir}/config.a.sh")
assert_contains "override: global only key" $'\nlog_to_file="0"\n' "${c}"
assert_contains "override: instance wins" $'\nno_pingers="3"\n' "${c}"
assert_contains "override: single option for array key" $'\nreflectors=("9.9.9.9")\n' "${c}"

err=$(bash "${C}" nosuch 2>&1); rc=$?
assert_eq "missing section: exit 1" 1 "${rc}"
assert_contains "missing section: message" "no UCI instance section 'nosuch'" "${err}"
err=$(bash "${C}" "bad id" 2>&1); rc=$?
assert_eq "bad id: exit 1" 1 "${rc}"
err=$(bash "${C}" 2>&1); rc=$?
assert_eq "no id: exit 1" 1 "${rc}"
rm -rf "${out_dir}"
report
```

- [ ] **Step 3: Run test to verify it fails**

Run: `wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && bash openwrt/tests/test_uci_to_config.sh'`
Expected: fails (`uci-to-config.sh: No such file`).

- [ ] **Step 4: Implement**

`openwrt/cake-autorate/files/uci-to-config.sh`:
```bash
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

id=${1:-}
case ${id} in
	''|*[!A-Za-z0-9_]*)
		printf 'uci-to-config: invalid instance id %s\n' "'${id}'" >&2
		exit 1
		;;
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
} > "${out}.tmp" && mv -f "${out}.tmp" "${out}"
```

- [ ] **Step 5: Run test to verify it passes**

Expected: `22 tests, 0 failed`.

- [ ] **Step 6: shellcheck and commit**

Run: `wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && shellcheck -x openwrt/cake-autorate/files/uci-to-config.sh'` → no findings.
```bash
git add openwrt/cake-autorate/files/uci-to-config.sh openwrt/tests/fixtures/uci/override openwrt/tests/test_uci_to_config.sh
git commit -m "Add UCI to bash config renderer"
```

---

### Task 5: procd init script, default UCI config, package Makefile

**Files:**
- Create: `openwrt/cake-autorate/files/cake-autorate.init`
- Create: `openwrt/cake-autorate/files/cake-autorate.config`
- Create: `openwrt/cake-autorate/Makefile`
- Test: `openwrt/tests/test_init_script.sh`

**Interfaces:**
- Consumes: `uci-to-config.sh <id>` (Task 4).
- Produces: `/etc/init.d/cake-autorate {start|stop|restart|reload|enable|disable|enabled} [instance]`; procd instances named after UCI sections; env overrides `CAKE_AUTORATE_SCRIPT_PREFIX`, `CAKE_AUTORATE_CONFIG_PREFIX` honoured (tests).

- [ ] **Step 1: Write the failing test**

`openwrt/tests/test_init_script.sh`:
```bash
#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
export UCI_CONFIG_DIR="${PWD}/fixtures/uci/basic"
export PROCD_LOG=$(mktemp)
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}"
export CAKE_AUTORATE_FUNCTIONS_SH="${PWD}/shim/openwrt-shim.sh"
cfg_dir=$(mktemp -d)
export CAKE_AUTORATE_CONFIG_PREFIX="${cfg_dir}"
. ./shim/openwrt-shim.sh

# On the router uci-to-config.sh sits in SCRIPT_PREFIX; here point the init script at the repo copy.
export CAKE_AUTORATE_UCI_TO_CONFIG="${REPO_ROOT}/openwrt/cake-autorate/files/uci-to-config.sh"

# Source the init script as a library (skip the rc.common shebang) and call its hooks.
. "${REPO_ROOT}/openwrt/cake-autorate/files/cake-autorate.init"
start_service
log=$(cat "${PROCD_LOG}")
assert_contains "enabled instance opened" "open wan" "${log}"
assert_not_contains "disabled instance skipped" "open lte" "${log}"
assert_contains "command" "param command ${REPO_ROOT}/cake-autorate.sh ${cfg_dir}/config.wan.sh" "${log}"
assert_contains "env" "param env CAKE_AUTORATE_SCRIPT_PREFIX=${REPO_ROOT} CAKE_AUTORATE_CONFIG_PREFIX=${cfg_dir}" "${log}"
assert_contains "file tracked" "param file ${cfg_dir}/config.wan.sh" "${log}"
assert_contains "respawn" "param respawn 3600 5 5" "${log}"
assert_contains "stderr" "param stderr 1" "${log}"
[ -f "${cfg_dir}/config.wan.sh" ] && pass "config rendered" || fail "config rendered"
[ -f "${cfg_dir}/config.lte.sh" ] && fail "disabled not rendered" || pass "disabled not rendered"
: > "${PROCD_LOG}"
service_triggers
assert_eq "reload trigger" "trigger cake-autorate" "$(cat "${PROCD_LOG}")"
rm -rf "${cfg_dir}" "${PROCD_LOG}"
report
```

- [ ] **Step 2: Run test to verify it fails**

Expected: fails (`cake-autorate.init: No such file`).

- [ ] **Step 3: Write the init script**

`openwrt/cake-autorate/files/cake-autorate.init`:
```sh
#!/bin/sh /etc/rc.common
# cake-autorate: one procd instance per enabled 'instance' section of /etc/config/cake-autorate.
#   service cake-autorate stop <id>     stop one instance (until the next reload)
#   service cake-autorate reload        (re)start instances whose config changed or that are missing
# shellcheck disable=SC2034
USE_PROCD=1
START=97
STOP=4

SCRIPT_PREFIX="${CAKE_AUTORATE_SCRIPT_PREFIX:-/usr/lib/cake-autorate}"
CONFIG_PREFIX="${CAKE_AUTORATE_CONFIG_PREFIX:-/var/etc/cake-autorate}"
UCI_TO_CONFIG="${CAKE_AUTORATE_UCI_TO_CONFIG:-${SCRIPT_PREFIX}/uci-to-config.sh}"

start_instance() {
	local id="$1" enabled

	config_get_bool enabled "$id" enabled 0
	[ "$enabled" -eq 1 ] || return 0

	if ! "$UCI_TO_CONFIG" "$id"; then
		logger -t cake-autorate "instance '$id': failed to render config from UCI, not starting"
		return 1
	fi

	procd_open_instance "$id"
	procd_set_param command "$SCRIPT_PREFIX/cake-autorate.sh" "$CONFIG_PREFIX/config.$id.sh"
	procd_set_param env CAKE_AUTORATE_SCRIPT_PREFIX="$SCRIPT_PREFIX" CAKE_AUTORATE_CONFIG_PREFIX="$CONFIG_PREFIX"
	procd_set_param file "$CONFIG_PREFIX/config.$id.sh"
	procd_set_param respawn 3600 5 5
	procd_set_param stderr 1
	procd_close_instance
}

start_service() {
	mkdir -p "$CONFIG_PREFIX"
	config_load cake-autorate
	config_foreach start_instance instance
}

# procd compares the new instance set with the running one and only restarts
# instances whose command/env/file changed; unchanged instances keep running.
reload_service() {
	start_service
}

service_triggers() {
	procd_add_reload_trigger cake-autorate
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: `11 tests, 0 failed`.

- [ ] **Step 5: Default UCI config**

`openwrt/cake-autorate/files/cake-autorate.config`:
```
config global 'global'

config instance 'primary'
	option enabled '0'
	option dl_if 'ifb4wan'
	option ul_if 'wan'
	option min_dl_shaper_rate_kbps '5000'
	option base_dl_shaper_rate_kbps '20000'
	option max_dl_shaper_rate_kbps '80000'
	option min_ul_shaper_rate_kbps '5000'
	option base_ul_shaper_rate_kbps '20000'
	option max_ul_shaper_rate_kbps '35000'

config mqtt 'mqtt'
	option enabled '0'
	option port '1883'
```

- [ ] **Step 6: Package Makefile**

`openwrt/cake-autorate/Makefile`:
```make
include $(TOPDIR)/rules.mk

PKG_NAME:=cake-autorate
PKG_VERSION:=3.5.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only
PKG_LICENSE_FILES:=LICENCE.md
PKG_MAINTAINER:=janklovicsmarton

include $(INCLUDE_DIR)/package.mk

# The scripts live in the repository root, two levels above this Makefile.
SRC_ROOT:=$(CURDIR)/../..

define Package/cake-autorate
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Traffic Shaping
  TITLE:=Adaptive CAKE bandwidth controller
  URL:=https://github.com/lynxthecat/cake-autorate
  DEPENDS:=+bash +fping +sqm-scripts +jsonfilter
  PKGARCH:=all
endef

define Package/cake-autorate/description
  cake-autorate adjusts CAKE bandwidth on variable-rate links (LTE, 5G,
  Starlink, cable) from measured load and one-way delay / RTT.
  One procd instance per 'instance' section in /etc/config/cake-autorate.
endef

define Package/cake-autorate/conffiles
/etc/config/cake-autorate
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/cake-autorate/install
	$(INSTALL_DIR) $(1)/usr/lib/cake-autorate
	$(INSTALL_BIN) $(SRC_ROOT)/cake-autorate.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_DATA) $(SRC_ROOT)/defaults.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_DATA) $(SRC_ROOT)/lib.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_BIN) $(SRC_ROOT)/mqtt-publisher.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_BIN) ./files/uci-to-config.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_BIN) ./files/migrate-legacy-config.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/cake-autorate.init $(1)/etc/init.d/cake-autorate
	$(INSTALL_BIN) ./files/mqtt-publisher.init $(1)/etc/init.d/mqtt-publisher
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/cake-autorate.config $(1)/etc/config/cake-autorate
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/cake-autorate.defaults $(1)/etc/uci-defaults/99-cake-autorate-migrate
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./files/rpcd-cake-autorate $(1)/usr/libexec/rpcd/cake-autorate
endef

$(eval $(call BuildPackage,cake-autorate))
```
(The Makefile references files created in Tasks 6–8; the CI build in Task 9 is the first time it is exercised. No custom `postinst`: OpenWrt's default postinst runs the uci-defaults script and enables the init scripts at boot.)

- [ ] **Step 7: shellcheck the init script**

Run: `wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && shellcheck -s sh -e SC1091 openwrt/cake-autorate/files/cake-autorate.init'` → no findings (SC1091: rc.common not resolvable locally).

- [ ] **Step 8: Commit**

```bash
git add openwrt/cake-autorate/files/cake-autorate.init openwrt/cake-autorate/files/cake-autorate.config openwrt/cake-autorate/Makefile openwrt/tests/test_init_script.sh
git commit -m "Add procd init with per-instance procd instances and package Makefile"
```

---

### Task 6: Legacy config migration

**Files:**
- Create: `openwrt/cake-autorate/files/migrate-legacy-config.sh`
- Create: `openwrt/cake-autorate/files/cake-autorate.defaults`
- Create: `openwrt/tests/fixtures/legacy/config.primary.sh`
- Test: `openwrt/tests/test_migrate.sh`

**Interfaces:**
- Consumes: `defaults.sh` at `${CAKE_AUTORATE_SCRIPT_PREFIX}`.
- Produces: `migrate-legacy-config.sh <enabled 0|1> <config.<id>.sh>...` → prints `uci batch` commands on stdout (`set cake-autorate.<id>=instance`, `set cake-autorate.<id>.enabled='N'`, one `set`/`add_list` per non-default key); uci-defaults script `99-cake-autorate-migrate` wires it up.

- [ ] **Step 1: Write the fixture**

`openwrt/tests/fixtures/legacy/config.primary.sh`:
```bash
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
```

- [ ] **Step 2: Write the failing test**

`openwrt/tests/test_migrate.sh`:
```bash
#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
M="${REPO_ROOT}/openwrt/cake-autorate/files/migrate-legacy-config.sh"
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}"

out=$(bash "${M}" 1 "${PWD}/fixtures/legacy/config.primary.sh"); rc=$?
assert_eq "exit 0" 0 "${rc}"
assert_contains "section" $'set cake-autorate.primary=instance\n' "${out}"
assert_contains "enabled" $'set cake-autorate.primary.enabled=\'1\'\n' "${out}"
assert_contains "changed value" $'set cake-autorate.primary.base_dl_shaper_rate_kbps=\'25000\'\n' "${out}"
assert_contains "float kept" $'set cake-autorate.primary.dl_owd_delta_delay_thr_ms=\'25.0\'\n' "${out}"
assert_contains "spaces quoted" $'set cake-autorate.primary.ping_prefix_string=\'mwan3 use wan exec\'\n' "${out}"
assert_contains "array -> add_list" $'add_list cake-autorate.primary.reflectors=\'1.1.1.1\'\nadd_list cake-autorate.primary.reflectors=\'8.8.8.8\'\n' "${out}"
assert_not_contains "default value omitted" "min_dl_shaper_rate_kbps" "${out}"
assert_not_contains "default flag omitted" "adjust_dl_shaper_rate" "${out}"
assert_contains "changed flag kept" "output_summary_stats='1'" "${out}"

out=$(bash "${M}" 0 /nonexistent/config.x.sh 2>&1); rc=$?
assert_eq "missing file: exit 1" 1 "${rc}"
out=$(bash "${M}" 0 "${PWD}/fixtures/legacy/notaconfig.sh" 2>&1); rc=$?
assert_eq "bad name: exit 1" 1 "${rc}"
report
```

- [ ] **Step 3: Run test to verify it fails**

Expected: fails (script missing).

- [ ] **Step 4: Implement the migration script**

`openwrt/cake-autorate/files/migrate-legacy-config.sh`:
```bash
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
```

- [ ] **Step 5: Run test to verify it passes**

Expected: `12 tests, 0 failed`.

- [ ] **Step 6: uci-defaults script**

`openwrt/cake-autorate/files/cake-autorate.defaults`:
```sh
#!/bin/sh
# One-shot on package install: import a setup.sh-style install into UCI,
# stop the legacy launcher, and register the rpcd plugin.
LEGACY=/root/cake-autorate
SCRIPT_PREFIX=/usr/lib/cake-autorate

/etc/init.d/rpcd reload 2>/dev/null

[ -d "$LEGACY" ] || exit 0
set -- "$LEGACY"/config.*.sh
[ -f "$1" ] || exit 0

# Legacy launcher (started by the old /etc/init.d/cake-autorate) must not run alongside procd instances.
for p in /proc/[0-9]*; do
	cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
	case "$cmd" in
		*"$LEGACY/launcher.sh"*|*"$LEGACY/cake-autorate.sh"*) kill "${p#/proc/}" 2>/dev/null ;;
	esac
done

enabled=0
ls /etc/rc.d/S*cake-autorate >/dev/null 2>&1 && enabled=1

for f in "$@"; do
	id=${f##*/config.}; id=${id%.sh}
	if [ "$(uci -q get "cake-autorate.$id")" = "instance" ] && [ "$id" != "primary" ]; then
		logger -t cake-autorate "migration: UCI section '$id' already exists, skipping $f"
		continue
	fi
	# the packaged default 'primary' section (enabled=0) is replaced by the legacy primary config
	uci -q delete "cake-autorate.$id"
	if "$SCRIPT_PREFIX/migrate-legacy-config.sh" "$enabled" "$f" | uci batch; then
		logger -t cake-autorate "migration: imported $f as UCI instance '$id' (enabled=$enabled); the legacy files under $LEGACY are no longer used and can be deleted"
	else
		logger -t cake-autorate "migration: failed to import $f"
	fi
done

if [ -f "$LEGACY/mqtt-publisher.config.sh" ]; then
	host=$(sed -n 's/^MQTT_HOST="\(.*\)"/\1/p' "$LEGACY/mqtt-publisher.config.sh")
	if [ -n "$host" ]; then
		uci -q set cake-autorate.mqtt=mqtt
		uci -q set cake-autorate.mqtt.host="$host"
		uci -q set cake-autorate.mqtt.port="$(sed -n 's/^MQTT_PORT="\(.*\)"/\1/p' "$LEGACY/mqtt-publisher.config.sh")"
		uci -q set cake-autorate.mqtt.user="$(sed -n 's/^MQTT_USER="\(.*\)"/\1/p' "$LEGACY/mqtt-publisher.config.sh")"
		uci -q set cake-autorate.mqtt.password="$(sed -n 's/^MQTT_PASS="\(.*\)"/\1/p' "$LEGACY/mqtt-publisher.config.sh")"
	fi
fi
uci commit cake-autorate
exit 0
```

- [ ] **Step 7: shellcheck both and commit**

Run: `wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && shellcheck openwrt/cake-autorate/files/migrate-legacy-config.sh && shellcheck -s sh openwrt/cake-autorate/files/cake-autorate.defaults'` → no findings.
```bash
git add openwrt/cake-autorate/files/migrate-legacy-config.sh openwrt/cake-autorate/files/cake-autorate.defaults openwrt/tests/fixtures/legacy openwrt/tests/test_migrate.sh
git commit -m "Migrate setup.sh-style configs into UCI on first install"
```

---

### Task 7: MQTT publisher init script

**Files:**
- Create: `openwrt/cake-autorate/files/mqtt-publisher.init`
- Create: `openwrt/tests/fixtures/uci/mqtt/cake-autorate`
- Test: `openwrt/tests/test_mqtt_init.sh`

**Interfaces:**
- Consumes: UCI section `mqtt` (`enabled`, `host`, `port`, `user`, `password`); `mqtt-publisher.sh` reads `${CAKE_AUTORATE_CONFIG_PREFIX}/mqtt-publisher.config.sh` and `config.*.sh` from the same directory.
- Produces: `/etc/init.d/mqtt-publisher`, generated `/var/etc/cake-autorate/mqtt-publisher.config.sh` (mode 0600).

- [ ] **Step 1: Fixture**

`openwrt/tests/fixtures/uci/mqtt/cake-autorate`:
```
config mqtt 'mqtt'
	option enabled '1'
	option host 'broker.lan'
	option port '1884'
	option user 'ha'
	option password 'p"a$s'
```

- [ ] **Step 2: Write the failing test**

`openwrt/tests/test_mqtt_init.sh`:
```bash
#!/usr/bin/env bash
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./assert.sh
export UCI_CONFIG_DIR="${PWD}/fixtures/uci/mqtt"
export PROCD_LOG=$(mktemp)
export CAKE_AUTORATE_SCRIPT_PREFIX="${REPO_ROOT}"
cfg_dir=$(mktemp -d)
export CAKE_AUTORATE_CONFIG_PREFIX="${cfg_dir}"
. ./shim/openwrt-shim.sh
. "${REPO_ROOT}/openwrt/cake-autorate/files/mqtt-publisher.init"
start_service
log=$(cat "${PROCD_LOG}")
assert_contains "command" "param command ${REPO_ROOT}/mqtt-publisher.sh" "${log}"
assert_contains "env" "param env CAKE_AUTORATE_CONFIG_PREFIX=${cfg_dir}" "${log}"
assert_contains "file tracked" "param file ${cfg_dir}/mqtt-publisher.config.sh" "${log}"
assert_contains "unlimited respawn" "param respawn 3600 10 0" "${log}"
c=$(cat "${cfg_dir}/mqtt-publisher.config.sh")
assert_contains "host" $'MQTT_HOST="broker.lan"\n' "${c}"
assert_contains "port" $'MQTT_PORT="1884"\n' "${c}"
assert_contains "password escaped" $'MQTT_PASS="p\\"a\\$s"\n' "${c}"
assert_eq "config mode 600" "600" "$(stat -c %a "${cfg_dir}/mqtt-publisher.config.sh")"
( . "${cfg_dir}/mqtt-publisher.config.sh" && assert_eq "password round-trips" 'p"a$s' "${MQTT_PASS}" )

export UCI_CONFIG_DIR="${PWD}/fixtures/uci/basic"   # mqtt enabled=0 there
: > "${PROCD_LOG}"
start_service
assert_eq "disabled: nothing opened" "" "$(cat "${PROCD_LOG}")"
rm -rf "${cfg_dir}" "${PROCD_LOG}"
report
```

- [ ] **Step 3: Run test to verify it fails**

Expected: fails (init missing).

- [ ] **Step 4: Implement**

`openwrt/cake-autorate/files/mqtt-publisher.init`:
```sh
#!/bin/sh /etc/rc.common
# mqtt-publisher: publish cake-autorate SUMMARY/CPU stats to an MQTT broker (Home Assistant discovery).
# Configured by the 'mqtt' section of /etc/config/cake-autorate.
# shellcheck disable=SC2034
USE_PROCD=1
START=98
STOP=10

SCRIPT_PREFIX="${CAKE_AUTORATE_SCRIPT_PREFIX:-/usr/lib/cake-autorate}"
CONFIG_PREFIX="${CAKE_AUTORATE_CONFIG_PREFIX:-/var/etc/cake-autorate}"

sh_escape() {
	# make a value safe inside double quotes in a sourced shell file
	printf '%s' "$1" | sed -e 's/[\\"$`]/\\&/g'
}

start_service() {
	local enabled host port user password cfg

	config_load cake-autorate
	config_get_bool enabled mqtt enabled 0
	[ "$enabled" -eq 1 ] || return 0
	config_get host mqtt host
	config_get port mqtt port 1883
	config_get user mqtt user
	config_get password mqtt password
	if [ -z "$host" ]; then
		logger -t mqtt-publisher "no MQTT host configured, not starting"
		return 1
	fi

	mkdir -p "$CONFIG_PREFIX"
	cfg="$CONFIG_PREFIX/mqtt-publisher.config.sh"
	(
		umask 077
		printf 'MQTT_HOST="%s"\nMQTT_PORT="%s"\nMQTT_USER="%s"\nMQTT_PASS="%s"\n' \
			"$(sh_escape "$host")" "$(sh_escape "$port")" "$(sh_escape "$user")" "$(sh_escape "$password")" > "$cfg.tmp"
	)
	mv -f "$cfg.tmp" "$cfg"

	procd_open_instance
	procd_set_param command "$SCRIPT_PREFIX/mqtt-publisher.sh"
	procd_set_param env CAKE_AUTORATE_CONFIG_PREFIX="$CONFIG_PREFIX"
	procd_set_param file "$cfg"
	# retry forever: the publisher exits when no instance log exists yet
	procd_set_param respawn 3600 10 0
	procd_set_param stderr 1
	procd_close_instance
}

reload_service() {
	restart
}

service_triggers() {
	procd_add_reload_trigger cake-autorate
}
```
Note: `mqtt-publisher.sh` computes `SCRIPT_PREFIX` from its own path and `CONFIG_PREFIX` from `CAKE_AUTORATE_CONFIG_PREFIX`; no change to it is needed.

- [ ] **Step 5: Run test to verify it passes**

Expected: `10 tests, 0 failed`.

- [ ] **Step 6: shellcheck and commit**

Run: `shellcheck -s sh -e SC1091 openwrt/cake-autorate/files/mqtt-publisher.init` → no findings.
```bash
git add openwrt/cake-autorate/files/mqtt-publisher.init openwrt/tests/fixtures/uci/mqtt openwrt/tests/test_mqtt_init.sh
git commit -m "Add procd init for the MQTT publisher driven by UCI"
```

---

### Task 8: rpcd backend

**Files:**
- Create: `openwrt/cake-autorate/files/rpcd-cake-autorate`
- Create: `openwrt/tests/router/smoke.sh`
- Test: local `sh -n` + shellcheck; on-router `smoke.sh`

**Interfaces:**
- Consumes: `status.json` (Task 3), init script (Task 5), `uci-to-config.sh` + `--check-config` (Tasks 2, 4), `${run_path}/log_file_export|log_file_reset` (existing).
- Produces: ubus object `cake-autorate` with methods and reply shapes exactly as spec §9: `status`, `instance_control{id,action}`, `check_config{id}`, `log_tail{id,lines}`, `log_export{id}`, `log_reset{id}`, `system_info`, `sqm_create{interface,dl_kbps,ul_kbps}`, `sqm_sync_rates{sqm_id,dl_kbps,ul_kbps}`, `mqtt_status`. Every reply carries `"ok": true|false` and, when `ok` is false, `"error": "<message>"`.

- [ ] **Step 1: Write the plugin**

`openwrt/cake-autorate/files/rpcd-cake-autorate`:
```sh
#!/bin/sh
# rpcd plugin: ubus object "cake-autorate" for the LuCI app (and for `ubus call` on the CLI).
# shellcheck disable=SC1091
. /usr/share/libubox/jshn.sh
. /lib/functions.sh
. /lib/functions/network.sh

RUN_DIR=/var/run/cake-autorate
INIT=/etc/init.d/cake-autorate
SCRIPT_PREFIX=/usr/lib/cake-autorate

reply_error() {
	json_init
	json_add_boolean ok 0
	json_add_string error "$1"
	json_dump
	exit 0
}

valid_id() {
	case "$1" in ''|*[!A-Za-z0-9_]*) return 1 ;; esac
	[ "$(uci -q get "cake-autorate.$1")" = "instance" ]
}

valid_number() {
	case "$1" in ''|*[!0-9]*) return 1 ;; esac
}

json_str() {
	# JSON-escape backslash and double quote, drop control characters (for hand-built JSON)
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r\t'
}

log_path_for() {
	local dir
	dir=$(uci -q get "cake-autorate.$1.log_file_path_override")
	[ -n "$dir" ] || dir=$(uci -q get cake-autorate.global.log_file_path_override)
	[ -n "$dir" ] && [ -d "$dir" ] || dir=/var/log
	printf '%s/cake-autorate.%s.log' "$dir" "$1"
}

cake_info() {
	# prints "<present 0|1> <bandwidth_kbps>" for the root qdisc of a device
	local out kind bw
	out=$(tc -j qdisc show dev "$1" 2>/dev/null) || { printf '0 0'; return; }
	kind=$(printf '%s' "$out" | jsonfilter -q -e '@[0].kind')
	[ "$kind" = "cake" ] || { printf '0 0'; return; }
	bw=$(printf '%s' "$out" | jsonfilter -q -e '@[0].options.bandwidth')
	valid_number "$bw" || bw=0
	printf '1 %d' $((bw * 8 / 1000))
}

# ---- status ---------------------------------------------------------------

status_instance() {
	local id="$1" enabled running pid exit_code sfile spid stale=0 dl_if ul_if
	local dl_present dl_bw ul_present ul_bw
	config_get_bool enabled "$id" enabled 0
	running=$(printf '%s' "$SVC" | jsonfilter -q -e "@['cake-autorate'].instances['$id'].running")
	pid=$(printf '%s' "$SVC" | jsonfilter -q -e "@['cake-autorate'].instances['$id'].pid")
	exit_code=$(printf '%s' "$SVC" | jsonfilter -q -e "@['cake-autorate'].instances['$id'].exit_code")
	[ "$running" = "true" ] && running=true || running=false
	valid_number "$pid" || pid=0
	valid_number "$exit_code" || exit_code=0
	config_get dl_if "$id" dl_if
	config_get ul_if "$id" ul_if

	printf '%s"%s":{"enabled":%s,"running":%s,"pid":%d,"exit_code":%d' "$SEP" "$id" \
		"$([ "$enabled" -eq 1 ] && echo true || echo false)" "$running" "$pid" "$exit_code"
	SEP=","

	sfile="$RUN_DIR/$id/status.json"
	if [ -r "$sfile" ]; then
		spid=$(jsonfilter -q -i "$sfile" -e '@.pid')
		valid_number "$spid" && [ ! -d "/proc/$spid" ] && stale=1
		printf ',"stale":%s,"status":%s' "$([ $stale -eq 1 ] && echo true || echo false)" "$(cat "$sfile")"
	else
		printf ',"stale":false,"status":null'
	fi

	# shellcheck disable=SC2046  # intentional word split of "present bw"
	set -- $(cake_info "$dl_if"); dl_present=$1; dl_bw=$2
	# shellcheck disable=SC2046
	set -- $(cake_info "$ul_if"); ul_present=$1; ul_bw=$2
	printf ',"cake_present":{"dl":%s,"ul":%s},"tc_bandwidth_kbps":{"dl":%d,"ul":%d}}' \
		"$([ "$dl_present" = 1 ] && echo true || echo false)" \
		"$([ "$ul_present" = 1 ] && echo true || echo false)" "$dl_bw" "$ul_bw"
}

do_status() {
	local version enabled
	SVC=$(ubus call service list '{"name":"cake-autorate","verbose":true}' 2>/dev/null)
	version=$(sed -n 's/^cake_autorate_version="\(.*\)"/\1/p' "$SCRIPT_PREFIX/cake-autorate.sh")
	"$INIT" enabled && enabled=true || enabled=false
	config_load cake-autorate
	printf '{"ok":true,"service_enabled":%s,"version":"%s","instances":{' "$enabled" "$(json_str "$version")"
	SEP=""
	config_foreach status_instance instance
	printf '}}\n'
}
```

Continue the file:
```sh
# ---- control / config -----------------------------------------------------

do_instance_control() {
	local id action enabled
	json_load "$INPUT"
	json_get_var id id
	json_get_var action action
	valid_id "$id" || reply_error "invalid instance id"
	case "$action" in
		stop)
			"$INIT" stop "$id" ;;
		start)
			config_load cake-autorate
			config_get_bool enabled "$id" enabled 0
			[ "$enabled" -eq 1 ] || reply_error "instance '$id' is disabled; enable it in the configuration first"
			"$INIT" reload ;;
		restart)
			"$INIT" stop "$id"
			"$INIT" reload ;;
		*)
			reply_error "invalid action" ;;
	esac
	json_init
	json_add_boolean ok 1
	json_add_string msg "$action requested for instance '$id'"
	json_dump
}

do_check_config() {
	local id tmp out rc line errs
	json_load "$INPUT"
	json_get_var id id
	valid_id "$id" || reply_error "invalid instance id"
	tmp=$(mktemp)
	if ! out=$("$SCRIPT_PREFIX/uci-to-config.sh" "$id" "$tmp" 2>&1); then
		rm -f "$tmp"
		reply_error "$out"
	fi
	out=$(CAKE_AUTORATE_SCRIPT_PREFIX="$SCRIPT_PREFIX" CAKE_AUTORATE_CONFIG_PREFIX=/var/etc/cake-autorate \
		"$SCRIPT_PREFIX/cake-autorate.sh" --check-config "$tmp" 2>&1); rc=$?
	rm -f "$tmp"
	json_init
	json_add_boolean ok 1
	json_add_boolean valid "$([ $rc -eq 0 ] && echo 1 || echo 0)"
	# no pipe into the loop: a piped `while` runs in a subshell in ash and would lose the json_add_string calls
	errs=$(printf '%s\n' "$out" | sed -n 's/^ERROR; [^;]*; [^;]*; //p')
	json_add_array errors
	IFS='
'
	for line in $errs; do json_add_string "" "$line"; done
	unset IFS
	json_close_array
	json_dump
}
```

```sh
# ---- logs -----------------------------------------------------------------

do_log_tail() {
	local id lines path size line
	json_load "$INPUT"
	json_get_var id id
	json_get_var lines lines
	valid_id "$id" || reply_error "invalid instance id"
	valid_number "$lines" || lines=200
	[ "$lines" -le 2000 ] || lines=2000
	path=$(log_path_for "$id")
	json_init
	json_add_boolean ok 1
	json_add_string path "$path"
	if [ -f "$path" ]; then
		size=$(wc -c < "$path")
		json_add_int size "$size"
		json_add_array lines
		IFS='
'
		for line in $(tail -n "$lines" "$path"); do json_add_string "" "$line"; done
		unset IFS
		json_close_array
	else
		json_add_int size 0
		json_add_array lines
		json_close_array
	fi
	json_dump
}

do_log_export() {
	local id helper out path
	json_load "$INPUT"
	json_get_var id id
	valid_id "$id" || reply_error "invalid instance id"
	helper="$RUN_DIR/$id/log_file_export"
	[ -x "$helper" ] || reply_error "instance '$id' is not running with log_to_file=1"
	out=$("$helper" 30 2>&1) || reply_error "$out"
	path=$(printf '%s\n' "$out" | sed -n 's/^Log file available at location: //p')
	[ -n "$path" ] || reply_error "export did not report a file: $out"
	json_init
	json_add_boolean ok 1
	json_add_string path "$path"
	json_dump
}

do_log_reset() {
	local id helper out
	json_load "$INPUT"
	json_get_var id id
	valid_id "$id" || reply_error "invalid instance id"
	helper="$RUN_DIR/$id/log_file_reset"
	[ -x "$helper" ] || reply_error "instance '$id' is not running with log_to_file=1"
	out=$("$helper" 2>&1) || reply_error "$out"
	json_init
	json_add_boolean ok 1
	json_dump
}

# ---- system info / SQM ----------------------------------------------------

sqm_entry() {
	local id="$1" iface qdisc script enabled download upload
	config_get iface "$id" interface
	config_get qdisc "$id" qdisc
	config_get script "$id" script
	config_get_bool enabled "$id" enabled 0
	config_get download "$id" download 0
	config_get upload "$id" upload 0
	json_add_object ""
	json_add_string id "$id"
	json_add_string interface "$iface"
	json_add_string qdisc "$qdisc"
	json_add_string script "$script"
	json_add_boolean enabled "$enabled"
	json_add_int download "${download:-0}"
	json_add_int upload "${upload:-0}"
	json_add_string ifb "ifb4$iface"
	json_close_object
}

mwan3_entry() {
	local name="$1" dev
	network_get_device dev "$name"
	json_add_object ""
	json_add_string name "$name"
	json_add_string device "${dev:-}"
	json_close_object
}

fping_ts_available() {
	local v major minor
	v=$(fping -v 2>/dev/null | sed -n 's/.*Version \([0-9]*\)\.\([0-9]*\).*/\1 \2/p')
	set -- $v
	major=${1:-0}; minor=${2:-0}
	[ "$major" -gt 5 ] || { [ "$major" -eq 5 ] && [ "$minor" -ge 3 ]; }
}

do_system_info() {
	json_init
	json_add_boolean ok 1
	if [ -f /etc/config/sqm ]; then
		json_add_boolean sqm_installed 1
		json_add_array sqm
		config_load sqm
		config_foreach sqm_entry queue
		json_close_array
	else
		json_add_boolean sqm_installed 0
		json_add_array sqm; json_close_array
	fi
	if [ -f /etc/config/mwan3 ]; then
		json_add_boolean mwan3_installed 1
		json_add_array mwan3
		config_load mwan3
		config_foreach mwan3_entry interface
		json_close_array
	else
		json_add_boolean mwan3_installed 0
		json_add_array mwan3; json_close_array
	fi
	json_add_object pingers
	json_add_boolean fping "$(command -v fping >/dev/null && echo 1 || echo 0)"
	json_add_boolean fping_ts "$(fping_ts_available && echo 1 || echo 0)"
	json_add_boolean tsping "$(command -v tsping >/dev/null && echo 1 || echo 0)"
	json_add_boolean irtt "$(command -v irtt >/dev/null && echo 1 || echo 0)"
	json_add_boolean ping "$(ping -V 2>&1 | grep -q iputils && echo 1 || echo 0)"
	json_close_object
	json_add_boolean mosquitto_installed "$(command -v mosquitto_pub >/dev/null && echo 1 || echo 0)"
	json_dump
}

do_sqm_create() {
	local iface dl ul id
	json_load "$INPUT"
	json_get_var iface interface
	json_get_var dl dl_kbps
	json_get_var ul ul_kbps
	case "$iface" in ''|*[!A-Za-z0-9_.-]*) reply_error "invalid interface" ;; esac
	valid_number "$dl" && valid_number "$ul" || reply_error "rates must be integers (kbit/s)"
	[ -f /etc/config/sqm ] || reply_error "sqm-scripts is not installed"
	id=$(printf '%s' "$iface" | tr -c 'A-Za-z0-9_' '_')
	[ "$(uci -q get "sqm.$id")" = "queue" ] && reply_error "SQM instance '$id' already exists"
	uci -q batch <<-EOF
		set sqm.$id=queue
		set sqm.$id.interface='$iface'
		set sqm.$id.enabled='1'
		set sqm.$id.qdisc='cake'
		set sqm.$id.script='piece_of_cake.qos'
		set sqm.$id.download='$dl'
		set sqm.$id.upload='$ul'
		set sqm.$id.linklayer='none'
		set sqm.$id.debug_logging='0'
		set sqm.$id.verbosity='5'
		commit sqm
	EOF
	/etc/init.d/sqm reload >/dev/null 2>&1
	json_init
	json_add_boolean ok 1
	json_add_string sqm_id "$id"
	json_dump
}

do_sqm_sync_rates() {
	local id dl ul
	json_load "$INPUT"
	json_get_var id sqm_id
	json_get_var dl dl_kbps
	json_get_var ul ul_kbps
	case "$id" in ''|*[!A-Za-z0-9_]*) reply_error "invalid sqm id" ;; esac
	[ "$(uci -q get "sqm.$id")" = "queue" ] || reply_error "no SQM instance '$id'"
	valid_number "$dl" && valid_number "$ul" || reply_error "rates must be integers (kbit/s)"
	uci -q set "sqm.$id.download=$dl"
	uci -q set "sqm.$id.upload=$ul"
	uci -q commit sqm
	/etc/init.d/sqm reload >/dev/null 2>&1
	json_init
	json_add_boolean ok 1
	json_dump
}

# ---- mqtt -----------------------------------------------------------------

summary_enabled_instance() {
	local id="$1" v
	config_get v "$id" output_summary_stats
	[ -n "$v" ] || config_get v global output_summary_stats 0
	[ "$v" = "1" ] && json_add_string "" "$id"
}

do_mqtt_status() {
	local running host
	running=$(ubus call service list '{"name":"mqtt-publisher"}' 2>/dev/null | jsonfilter -q -e '@["mqtt-publisher"].instances.instance1.running')
	config_load cake-autorate
	config_get host mqtt host
	json_init
	json_add_boolean ok 1
	json_add_boolean running "$([ "$running" = "true" ] && echo 1 || echo 0)"
	json_add_boolean configured "$([ -n "$host" ] && echo 1 || echo 0)"
	json_add_boolean mosquitto_installed "$(command -v mosquitto_pub >/dev/null && echo 1 || echo 0)"
	json_add_array summary_stats_enabled_instances
	config_foreach summary_enabled_instance instance
	json_close_array
	json_dump
}

# ---- dispatch -------------------------------------------------------------

case "$1" in
	list)
		cat <<-'EOF'
		{
		  "status": {},
		  "instance_control": { "id": "str", "action": "str" },
		  "check_config": { "id": "str" },
		  "log_tail": { "id": "str", "lines": 0 },
		  "log_export": { "id": "str" },
		  "log_reset": { "id": "str" },
		  "system_info": {},
		  "sqm_create": { "interface": "str", "dl_kbps": 0, "ul_kbps": 0 },
		  "sqm_sync_rates": { "sqm_id": "str", "dl_kbps": 0, "ul_kbps": 0 },
		  "mqtt_status": {}
		}
		EOF
		;;
	call)
		read -r INPUT
		case "$2" in
			status)           do_status ;;
			instance_control) do_instance_control ;;
			check_config)     do_check_config ;;
			log_tail)         do_log_tail ;;
			log_export)       do_log_export ;;
			log_reset)        do_log_reset ;;
			system_info)      do_system_info ;;
			sqm_create)       do_sqm_create ;;
			sqm_sync_rates)   do_sqm_sync_rates ;;
			mqtt_status)      do_mqtt_status ;;
			*)                reply_error "unknown method" ;;
		esac
		;;
esac
```

- [ ] **Step 2: Syntax and shellcheck**

Run: `wsl -e bash -c 'cd "/mnt/c/dev/cake autorate" && sh -n openwrt/cake-autorate/files/rpcd-cake-autorate && shellcheck -s sh -e SC1091 openwrt/cake-autorate/files/rpcd-cake-autorate'`
Expected: no output. The intentional word splits (`set -- $(cake_info ...)`, `set -- $v`) carry inline `# shellcheck disable=SC2046` comments; add the same for `set -- $v` in `fping_ts_available`.

- [ ] **Step 3: Write the on-router smoke test**

`openwrt/tests/router/smoke.sh` (copy to the router and run as root after installing the package; prints PASS/FAIL per check):
```sh
#!/bin/sh
# On-router smoke test for the cake-autorate package. Usage: sh smoke.sh <instance-id>
id=${1:-primary}
fails=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }

check "rpcd object registered"      "ubus list | grep -qx cake-autorate"
check "status ok"                   "ubus call cake-autorate status | jsonfilter -e '@.ok' | grep -q true"
check "instance listed"             "ubus call cake-autorate status | jsonfilter -e '@.instances.$id' >/dev/null"
check "system_info ok"              "ubus call cake-autorate system_info | jsonfilter -e '@.sqm_installed' >/dev/null"
check "check_config valid"          "ubus call cake-autorate check_config '{\"id\":\"$id\"}' | jsonfilter -e '@.valid' | grep -q true"
check "bad id rejected"             "ubus call cake-autorate check_config '{\"id\":\"../x\"}' | jsonfilter -e '@.ok' | grep -q false"

/etc/init.d/cake-autorate reload; sleep 3
check "instance running"            "ubus call cake-autorate status | jsonfilter -e '@.instances.$id.running' | grep -q true"
sleep 3
check "status.json present"         "test -r /var/run/cake-autorate/$id/status.json"
check "status embedded"             "ubus call cake-autorate status | jsonfilter -e '@.instances.$id.status.state' | grep -qE 'running|idle|stall|waiting_for_if'"
check "log_tail ok"                 "ubus call cake-autorate log_tail '{\"id\":\"$id\",\"lines\":5}' | jsonfilter -e '@.ok' | grep -q true"

ubus call cake-autorate instance_control "{\"id\":\"$id\",\"action\":\"stop\"}" >/dev/null; sleep 2
check "stop: not running"           "ubus call cake-autorate status | jsonfilter -e '@.instances.$id.running' | grep -q false"
check "stop: run dir cleaned"       "! test -d /var/run/cake-autorate/$id"
ubus call cake-autorate instance_control "{\"id\":\"$id\",\"action\":\"start\"}" >/dev/null; sleep 3
check "start: running again"        "ubus call cake-autorate status | jsonfilter -e '@.instances.$id.running' | grep -q true"

# a config change must restart only the edited instance
pid_before=$(ubus call cake-autorate status | jsonfilter -e "@.instances.$id.pid")
uci set cake-autorate.$id.no_pingers=5; uci commit cake-autorate; /etc/init.d/cake-autorate reload; sleep 3
pid_after=$(ubus call cake-autorate status | jsonfilter -e "@.instances.$id.pid")
check "edited instance restarted"   "test \"$pid_before\" != \"$pid_after\""
uci revert cake-autorate 2>/dev/null; uci -q delete cake-autorate.$id.no_pingers; uci commit cake-autorate; /etc/init.d/cake-autorate reload

echo "$fails failure(s)"
[ "$fails" -eq 0 ]
```
With two instances configured, additionally verify by hand that editing one leaves the other's `pid` unchanged.

- [ ] **Step 4: Commit**

```bash
git add openwrt/cake-autorate/files/rpcd-cake-autorate openwrt/tests/router/smoke.sh
git commit -m "Add rpcd backend exposing status, control, config check, logs, SQM/mwan3 info"
```

---

### Task 9: CI workflow and docs

**Files:**
- Create: `.github/workflows/openwrt-packages.yml`
- Modify: `INSTALLATION.md` (new section "Installation as an OpenWrt package")
- Modify: `README.md` (one paragraph + link under Installation)

- [ ] **Step 1: Workflow**

`.github/workflows/openwrt-packages.yml`:
```yaml
name: OpenWrt packages

on:
  push:
    branches: ['**']
    tags: ['v*']
  pull_request:
  workflow_dispatch:

permissions:
  contents: write

jobs:
  test:
    name: shellcheck + unit tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update && sudo apt-get install -y shellcheck jq
      - name: shellcheck (bash scripts)
        run: shellcheck -x cake-autorate.sh lib.sh defaults.sh openwrt/cake-autorate/files/uci-to-config.sh openwrt/cake-autorate/files/migrate-legacy-config.sh
      - name: shellcheck (sh scripts)
        run: shellcheck -s sh -e SC1091 openwrt/cake-autorate/files/cake-autorate.init openwrt/cake-autorate/files/mqtt-publisher.init openwrt/cake-autorate/files/cake-autorate.defaults openwrt/cake-autorate/files/rpcd-cake-autorate
      - name: unit tests
        run: bash openwrt/tests/run-tests.sh

  build:
    name: build ${{ matrix.version }}
    needs: test
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        version: ['24.10.0', '25.12.0']
    steps:
      - uses: actions/checkout@v4
      - name: Build with the OpenWrt SDK
        uses: openwrt/gh-action-sdk@main
        env:
          ARCH: x86_64-${{ matrix.version }}
          FEEDNAME: cakeautorate
          PACKAGES: cake-autorate
          IGNORE_ERRORS: 0
      - name: Collect packages
        run: |
          mkdir -p dist
          find bin/packages -type f \( -name 'cake-autorate*.ipk' -o -name 'cake-autorate*.apk' -o -name 'luci-app-cake-autorate*.ipk' -o -name 'luci-app-cake-autorate*.apk' \) -exec cp {} dist/ \;
          ls -l dist
      - uses: actions/upload-artifact@v4
        with:
          name: packages-${{ matrix.version }}
          path: dist/*
      - name: Attach to release
        if: startsWith(github.ref, 'refs/tags/')
        uses: softprops/action-gh-release@v2
        with:
          files: dist/*
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```
(Plan B adds `luci-app-cake-autorate` to `PACKAGES`.) The package is `PKGARCH:=all`, so one SDK arch per version is enough.

- [ ] **Step 2: INSTALLATION.md section**

Add after "## Installation Steps (OpenWrt)":
```markdown
## Installation as an OpenWrt package (recommended on OpenWrt)

Download `cake-autorate_*.apk` (OpenWrt 25.12+) or `cake-autorate_*.ipk`
(OpenWrt 24.10) from the Releases page of this fork and install it:

    apk add --allow-untrusted cake-autorate_*.apk     # or: opkg install cake-autorate_*.ipk

Configuration lives in `/etc/config/cake-autorate`: one `instance` section
per WAN, option names identical to the variables in `defaults.sh`, arrays
(`reflectors`) as `list` entries. Existing `/root/cake-autorate/config.*.sh`
files from a `setup.sh` install are imported automatically on first install.

    uci set cake-autorate.primary.enabled=1
    uci set cake-autorate.primary.dl_if=ifb4wan
    uci set cake-autorate.primary.ul_if=wan
    uci commit cake-autorate
    service cake-autorate reload

Each instance is a separate procd instance: `service cake-autorate stop <id>`
stops one, `service cake-autorate reload` restarts only instances whose
configuration changed. Status: `ubus call cake-autorate status`.
```

- [ ] **Step 3: Push and watch CI**

The fork must exist on GitHub (`git remote add origin <fork-url>` if not yet). Push the branch and confirm both jobs are green in the Actions tab; download the `packages-25.12.0` artifact and check it contains `cake-autorate_3.5.0-r1.apk`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/openwrt-packages.yml INSTALLATION.md README.md
git commit -m "Add CI: shellcheck, unit tests and OpenWrt SDK package builds"
```

---

### Task 10: Router verification

**Files:** none (verification only; fix-ups go into the task that owns the file).

- [ ] **Step 1: Install on the router** (`scp` the `.apk` from the CI artifact, then `apk add --allow-untrusted ./cake-autorate_*.apk`). Check: `ubus list | grep cake-autorate`, `uci show cake-autorate` (migrated instances present if there was a legacy install), `logread -e cake-autorate | tail`.
- [ ] **Step 2: Run** `sh /tmp/smoke.sh <id>` (Task 8 Step 3) → `0 failure(s)`.
- [ ] **Step 3: Multi-instance check:** add a second instance (`uci set cake-autorate.second=instance; uci set cake-autorate.second.enabled=1; uci set cake-autorate.second.dl_if=...; uci set cake-autorate.second.ul_if=...; uci commit; service cake-autorate reload`). Note both pids; edit only `second`; reload; confirm `primary`'s pid is unchanged and `second`'s changed. `service cake-autorate stop second` → only `second` gone from `ubus call service list '{"name":"cake-autorate"}'`.
- [ ] **Step 4: Status content:** under a speed test `ubus call cake-autorate status` shows changing `dl.achieved_kbps`, `dl.shaper_kbps`, `dl.load` = `high`.
- [ ] **Step 5: MQTT (if a broker is available):** `uci set cake-autorate.mqtt.enabled=1; uci set cake-autorate.mqtt.host=...; uci commit; service mqtt-publisher restart` → `ubus call cake-autorate mqtt_status` reports `running: true`.
- [ ] **Step 6:** Record any deviation found on hardware as a fix in the owning task, re-run the unit tests, commit.

---

## Self-review notes

- Spec coverage: §3 layout → Tasks 5, 9; §4 schema → Tasks 4, 5, 7; §5 converter → Task 4; §6 script changes → Tasks 2, 3; §7 init → Task 5 (+7 for MQTT); §8 migration → Task 6; §9 rpcd → Task 8 (ACL belongs to plan B with the LuCI app); §12 testing → Tasks 1–8 unit tests, Task 8 smoke, Task 10 hardware; §13 CI → Task 9.
- Names used across tasks: `write_status_file`, `write_status_file_waiting`, `build_status_json` (Task 3, used by Task 8's `status.json` reader); `uci-to-config.sh <id> [out]` (Task 4, used by Tasks 5 and 8); `--check-config` (Task 2, used by Tasks 4 and 8); `migrate-legacy-config.sh <0|1> <files>` (Task 6); env names `CAKE_AUTORATE_SCRIPT_PREFIX`, `CAKE_AUTORATE_CONFIG_PREFIX`, `CAKE_AUTORATE_FUNCTIONS_SH`, `CAKE_AUTORATE_UCI_TO_CONFIG` consistent in Tasks 1, 4, 5, 7.
