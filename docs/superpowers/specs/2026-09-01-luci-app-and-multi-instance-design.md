# cake-autorate: OpenWrt packaging, per-instance procd service and LuCI app — design

Date: 2026-09-01
Status: approved (brainstorming complete), awaiting implementation plan
Branch: `feature/luci-app-multi-instance`

## 1. Goal

Make cake-autorate fully manageable from the OpenWrt web UI (LuCI) for both
single-WAN and multi-WAN routers, without rewriting the proven bash
algorithm. Concretely:

- Proper OpenWrt packages (`cake-autorate`, `luci-app-cake-autorate`)
  installable as `.ipk` (24.10) and `.apk` (25.12+), built by CI.
- UCI (`/etc/config/cake-autorate`) as the single source of truth on
  OpenWrt, one section per instance.
- One procd instance per cake-autorate instance: individual start / stop /
  restart, and a config change restarts only the affected instance.
- A LuCI app: configuration of every parameter, per-instance service
  control, live status with rolling charts, log viewing / export / reset,
  MQTT publisher configuration, SQM and mwan3 integration.
- Migration of existing `setup.sh`-style installs
  (`/root/cake-autorate/config.*.sh`) into UCI on first package install.

Non-goals:

- Replacing SQM / managing CAKE qdiscs ourselves (as DARKMOON does). We
  depend on `sqm-scripts` and only *integrate* with it.
- Changing the rate-control algorithm, IPC, pingers or log format.
- Server-side history of status data (charts are client-side only).
- Breaking Asus Merlin / Debian installs: `setup.sh`, `launcher.sh`,
  systemd unit stay untouched.

## 2. Background / findings

- Multi-instance already works in the script: one instance per
  `config.<id>.sh`, per-instance run dir `/var/run/cake-autorate/<id>/`
  (contains `proc_pids`, `run_token`, `log_file_export`, `log_file_reset`),
  per-instance log `/var/log/cake-autorate.<id>.log`, syslog tag
  `cake-autorate.<id>`.
- A rudimentary UCI mode exists in `launcher.sh.template` (Jan 2025): it
  generates `config.<section>.sh` from `uci show`. Weaknesses: single
  procd service for all instances (no per-instance control, no reload
  trigger), naive conversion (list options such as `reflectors` do not
  become bash arrays and would fail `validate_config_entry`).
- No package, no ACL, no rpcd backend, no machine-readable status: the only
  runtime information sources are the log file, `proc_pids` and `tc`.
- Multi-WAN probe routing is the user's job today via `ping_prefix_string`
  (e.g. `mwan3 use wan2 exec`) or `ping_extra_args`.
- Compared alternative: DARKMOON (C rewrite + LuCI). Good packaging / init /
  UI patterns to borrow; but a single shared `/var/run/darkmoon.json`
  (instances overwrite each other), no probe routing per WAN, no irtt /
  fping / log analysis / MQTT, young codebase. Decision: build on
  cake-autorate bash, borrow DARKMOON's packaging and UI structure.

Verified procd facts (from `procd.sh` / `rc.common` on main):

- `/etc/init.d/<svc> stop <instance>` → `procd_kill svc instance` kills only
  that instance.
- `start_service "$@"` receives extra args, but the ubus `service set` call
  replaces the whole instance list. Therefore `start_service` must always
  emit *all* enabled instances; procd diffs and only (re)starts instances
  whose definition changed or that are missing.
- `procd_set_param file <path>` makes procd track the file's checksum and
  restart the instance when it changes.

## 3. Repository and package layout

The fork keeps every existing file in place (upstream merges stay easy).
New top-level directory `openwrt/` plus CI workflow and this spec.

```
openwrt/
├── cake-autorate/
│   ├── Makefile                      PKGARCH:=all; copies scripts from repo root
│   └── files/
│       ├── cake-autorate.init        → /etc/init.d/cake-autorate
│       ├── cake-autorate.config      → /etc/config/cake-autorate (default 'primary', enabled=0)
│       ├── cake-autorate.defaults    → /etc/uci-defaults/99-cake-autorate-migrate
│       ├── uci-to-config.sh          → /usr/lib/cake-autorate/uci-to-config.sh
│       ├── mqtt-publisher.init       → /etc/init.d/mqtt-publisher
│       └── rpcd-cake-autorate        → /usr/libexec/rpcd/cake-autorate
└── luci-app-cake-autorate/
    ├── Makefile                      standard luci.mk; LUCI_DEPENDS:=+cake-autorate
    ├── htdocs/luci-static/resources/
    │   ├── cake-autorate/api.js      shared rpc declarations + formatters
    │   ├── view/cake-autorate/overview.js
    │   ├── view/cake-autorate/instances.js
    │   ├── view/cake-autorate/log.js
    │   ├── view/cake-autorate/mqtt.js
    │   └── view/status/include/75_cake-autorate.js
    ├── root/usr/share/luci/menu.d/luci-app-cake-autorate.json
    ├── root/usr/share/rpcd/acl.d/luci-app-cake-autorate.json
    └── po/templates/cake-autorate.pot, po/hu/cake-autorate.po
.github/workflows/openwrt-packages.yml
```

Install paths on the router:

| What | Path |
|---|---|
| scripts (`cake-autorate.sh`, `defaults.sh`, `lib.sh`, `mqtt-publisher.sh`, `uci-to-config.sh`) | `/usr/lib/cake-autorate/` (already in `POSSIBLE_SCRIPT_PREFIXES`) |
| UCI config (source of truth) | `/etc/config/cake-autorate` |
| generated bash configs (RAM) | `/var/etc/cake-autorate/config.<id>.sh`, `/var/etc/cake-autorate/mqtt-publisher.config.sh` |
| runtime | `/var/run/cake-autorate/<id>/` (unchanged) + `status.json` |
| logs | `/var/log/cake-autorate.<id>.log` (unchanged) |

Dependencies: `cake-autorate` → `+bash +fping +sqm-scripts +jsonfilter`;
`luci-app-cake-autorate` → `+cake-autorate` (+ luci-base via luci.mk).
Recommended (not hard): `luci-app-sqm`, `mosquitto-client-nossl` (MQTT),
`mwan3`, `irtt`, `tsping`. The UI reports what is missing.

`launcher.sh` is not installed by the package (only the `setup.sh` path
uses it).

## 4. UCI schema

```
config global 'global'
    option log_to_file '1'                 # any defaults.sh key; applied to all instances
    option log_file_max_time_mins '10'
    option log_file_max_size_KB '2000'

config instance 'wan'                      # section name == instance id
    option enabled '1'
    option sqm_instance 'wan'              # UI helper only, filtered out of the bash config
    option dl_if 'ifb4wan'
    option ul_if 'wan'
    option min_dl_shaper_rate_kbps '5000'
    ...                                    # any defaults.sh key as option
    list reflectors '1.1.1.1'              # array-typed keys as list
    list reflectors '8.8.8.8'
    option ping_prefix_string 'mwan3 use wan exec'

config mqtt 'mqtt'
    option enabled '0'
    option host '' ; option port '1883' ; option user '' ; option password ''
```

Rules:

- Option names are exactly the `defaults.sh` variable names. No mapping
  table. Anything not set falls back to `defaults.sh`.
- Non-`defaults.sh` keys: `enabled`, `sqm_instance`, `sqm_sync_base_rates`
  (instance), and the `mqtt` section. They are filtered out of the
  generated bash config.
- Instance ids match `^[a-zA-Z0-9_]+$` (they become file and directory
  names).
- Two instances must not share `dl_if` or `ul_if` (UI validation).

## 5. `uci-to-config.sh <id>`

- Uses `config_load cake-autorate` / `config_get` / `config_list_foreach`
  (not `uci show` text munging).
- Determines array-typed keys by grepping `defaults.sh` for `^name=(`
  (currently `reflectors`). Lists become `name=("a" "b")`; everything else
  `name="value"` (quoted; the script's `str_type` inspects content, so
  quoting is harmless).
- Emits `global` options first, then instance options (instance wins).
- Writes `config.<id>.sh.tmp`, then `mv` (atomic; procd sees one change).
- Header comment: "generated from UCI, do not edit".
- Exit 1 with a message on stderr if the section does not exist.

## 6. Changes to `cake-autorate.sh` and `defaults.sh`

Kept minimal for upstream mergeability.

a) **Status file.** New `defaults.sh` key `status_file_interval_ms=1000`
   (`0` disables; then behaviour is byte-identical to today). New function
   `write_status_file` called from the main loop when
   `t_now - t_last_status_write >= interval`, following the existing timer
   pattern (as `reflector_health_check`). Writes
   `${run_path}/status.json.tmp` then `mv` to `${run_path}/status.json`.
   Content (all values already exist as script variables):

   ```json
   { "instance":"wan", "version":"3.5.0", "pid":1733, "uptime_s":3612,
     "state":"running|idle|stall|waiting_for_if",
     "dl_if":"ifb4wan", "ul_if":"wan",
     "pinger_method":"fping", "pingers_active":1, "last_ping_age_ms":120,
     "dl":{ "shaper_kbps":48200, "achieved_kbps":41000, "load":"high|low|idle",
            "bufferbloat":0, "avg_owd_delta_ms":4.2, "delay_thr_ms":30.0,
            "max_adjust_down_thr_ms":60.0, "sum_delays":0,
            "min_kbps":5000, "base_kbps":20000, "max_kbps":80000, "adjust":1 },
     "ul":{ ...same keys... },
     "reflectors":{ "active":6, "list":["1.1.1.1","..."] } }
   ```
   `state` is derived from existing flags: `sustained_connection_idle`
   (sleeping) → `idle`; stall detection → `stall`; `verify_ifs_up`
   waiting → `waiting_for_if`; otherwise `running`.
   The file is removed by the existing cleanup (`rm -r ${run_path}`).

b) **`--check-config <path>`.** If the first argument is `--check-config`,
   the script runs only the existing validation block
   (`cake-autorate.sh` ~lines 1001-1041) with errors printed to stdout,
   then exits 0 (valid) or 1 (invalid). No processes are spawned, no run
   dir is created, no log is written.

c) Nothing else: algorithm, logging, IPC, pingers, `launcher.sh`, systemd
   and Asus paths are unchanged.

## 7. Init script `/etc/init.d/cake-autorate`

```sh
#!/bin/sh /etc/rc.common
USE_PROCD=1
START=97
STOP=4
SCRIPT_PREFIX=/usr/lib/cake-autorate
CONFIG_PREFIX=/var/etc/cake-autorate

start_instance() {
    local id="$1" enabled
    config_get_bool enabled "$id" enabled 0
    [ "$enabled" -eq 1 ] || return 0
    "$SCRIPT_PREFIX/uci-to-config.sh" "$id" || return 1
    procd_open_instance "$id"
    procd_set_param command "$SCRIPT_PREFIX/cake-autorate.sh" "$CONFIG_PREFIX/config.$id.sh"
    procd_set_param env CAKE_AUTORATE_SCRIPT_PREFIX="$SCRIPT_PREFIX" \
                        CAKE_AUTORATE_CONFIG_PREFIX="$CONFIG_PREFIX"
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

reload_service() { start_service; }          # procd diffs; only changed/new instances (re)start

service_triggers() { procd_add_reload_trigger cake-autorate; }
```

Behaviour:

- `service cake-autorate stop <id>` stops one instance; `reload` brings it
  back (it is still `enabled=1`). Persistent stop = `enabled=0` + reload.
- `service cake-autorate restart <id>` = stop `<id>` + reload.
- Save & Apply in LuCI commits UCI → procd reload trigger → only instances
  whose generated file changed are restarted. Verified on hardware during
  testing (item in §12).
- `mqtt-publisher` init: generates
  `/var/etc/cake-autorate/mqtt-publisher.config.sh` from the `mqtt` UCI
  section and runs `mqtt-publisher.sh` with
  `CAKE_AUTORATE_CONFIG_PREFIX=/var/etc/cake-autorate` (the publisher
  discovers `config.*.sh` and `mqtt-publisher.config.sh` there and
  `defaults.sh` next to itself). Reload trigger on `cake-autorate`.

## 8. Migration (`/etc/uci-defaults/99-cake-autorate-migrate`)

Runs once on first install. For each `/root/cake-autorate/config.<id>.sh`:

- Evaluates the file in a sandboxed bash (`bash -c 'set -a; . file; declare -p'`
  restricted to the key list from `defaults.sh`) and creates UCI section
  `instance '<id>'` with every override; arrays become lists.
- Sets `enabled=1` if the old `/etc/init.d/cake-autorate` was enabled
  (`/etc/rc.d/S*cake-autorate` exists), else `0`.
- If `/root/cake-autorate/mqtt-publisher.config.sh` has a host, fills the
  `mqtt` section.
- The package's `/etc/init.d/cake-autorate` and `/etc/init.d/mqtt-publisher`
  replace the `setup.sh`-generated ones. Because the old init script is
  already gone when uci-defaults runs, a still-running launcher-based
  install cannot be stopped through it; the migration script instead
  terminates processes whose `/proc/*/cmdline` contains
  `/root/cake-autorate/launcher.sh` or `/root/cake-autorate/cake-autorate.sh`
  (SIGTERM, then the normal cleanup removes `/var/run/cake-autorate/*`).
- Old files under `/root/cake-autorate` are left in place; a syslog line
  says they were migrated and can be deleted.

## 9. rpcd backend `/usr/libexec/rpcd/cake-autorate`

Shell, standard `list` / `call` protocol, `jshn`. ubus object
`cake-autorate`.

| Method | Params | Returns | Implementation |
|---|---|---|---|
| `status` | — | `service_enabled`, `version`, `instances{ id: { enabled, running, respawning, exit_code, stale, status{…status.json…}, cake_present{dl,ul}, tc_bandwidth_kbps{dl,ul} } }` | `ubus call service list '{"name":"cake-autorate"}'`, `status.json` per run dir (`stale` if `pid` not in `/proc`), `tc -j qdisc show dev X` |
| `instance_control` | `id`, `action` ∈ start/stop/restart | `ok`, `msg` | `service cake-autorate stop id` / `reload` / both |
| `check_config` | `id` | `ok`, `errors[]` | `uci-to-config.sh` to a temp file + `cake-autorate.sh --check-config` |
| `log_tail` | `id`, `lines` (≤2000) | `path`, `size`, `lines[]` | `tail -n` |
| `log_export` | `id` | `ok`, `path` | `${run_path}/log_file_export` (SIGUSR1 helper) |
| `log_reset` | `id` | `ok` | `${run_path}/log_file_reset` (SIGUSR2 helper) |
| `system_info` | — | `sqm_installed`, `sqm[]{id, interface, qdisc, script, enabled, download, upload, ifb}`, `mwan3_installed`, `mwan3[]{name, device}`, `pingers{fping, fping_ts, tsping, irtt, ping}`, `mosquitto_installed` | `/etc/config/sqm`, `/etc/config/mwan3`, `command -v`, `fping -v` ≥ 5.3 for fping-ts |
| `sqm_create` | `interface`, `dl_kbps`, `ul_kbps` | `ok`, `sqm_id` | `uci add sqm queue`, qdisc=cake, script=piece_of_cake.qos, enabled=1, commit, `service sqm reload` |
| `sqm_sync_rates` | `sqm_id`, `dl_kbps`, `ul_kbps` | `ok` | uci set download/upload, commit, `service sqm reload` |
| `mqtt_status` | — | `running`, `configured`, `summary_stats_enabled_instances[]` | procd + UCI |

Rules: `id` validated against `^[A-Za-z0-9_]+$` **and** existence as a UCI
section; `lines` numeric; `action` whitelisted; no unquoted expansion of
inputs. `status` returns everything in one call so polling is a single
ubus request regardless of instance count.

ACL (`luci-app-cake-autorate.json`):

- read: `ubus cake-autorate: [status, check_config, log_tail, system_info, mqtt_status]`,
  `uci: [cake-autorate, sqm, mwan3]`, `ubus file: [read, stat]` restricted by
  path to `/var/log/cake-autorate*` (for downloading exports),
  `ubus service: [list]`, `ubus luci: [getInitList, getInitStatus]`.
- write: `ubus cake-autorate: [instance_control, log_export, log_reset, sqm_create, sqm_sync_rates]`,
  `uci: [cake-autorate, sqm]`, `ubus luci: [setInitAction]`.

## 10. LuCI app

Menu: Services → CAKE Autorate, tabs Overview / Instances / Log / MQTT.
Pure JS `view`s on `form`, `ui`, `rpc`, `poll`; no external libraries.

### 10.1 Overview (`overview.js`)

- Header: version, service enabled at boot (toggle via `setInitAction`),
  running count; buttons Start all / Stop all / Restart all.
- One card per UCI instance:
  - Title row: id, `dl_if`/`ul_if`, state dot (running / idle / stall /
    waiting_for_if / starting / crashed-respawning / stopped / disabled),
    uptime, PID, buttons Start / Stop / Restart (this instance only).
  - Warning strip when: CAKE not present on dl_if/ul_if; assigned SQM
    instance disabled; configured pinger binary missing; more than one
    instance and both `ping_prefix_string` and `ping_extra_args` empty
    ("probes may not traverse this WAN").
  - Table, rows DL / UL: Shaper | Achieved | Load | OWD Δ (coloured against
    `delay_thr_ms`) | Bufferbloat | min / base / max.
  - Two inline-SVG charts (pattern of `luci-mod-status` realtime graphs),
    client-side ring buffer of 300 samples at the 2 s poll (10 min):
    1. Bandwidth: shaper DL/UL lines + achieved DL/UL filled areas;
       min/max guide lines.
    2. Latency: OWD Δ DL/UL lines; `delay_thr` and
       `max_adjust_down_thr` guide lines; bufferbloat events as vertical
       markers.
  - Reflectors: active list, pinger method.
- Polling: one `cake-autorate.status` call every 2 s via LuCI `poll`.

### 10.2 Instances (`instances.js`)

- `form.Map('cake-autorate')`. Small block for the `global` section
  (log limits). `GridSection` over `instance` sections, `addremove=true`,
  named sections validated `[a-zA-Z0-9_]+`; extra **Clone** action
  (copy all options to a new id).
- Edit modal with tabs:
  - **General**: enabled; SQM instance dropdown (from `system_info.sqm`;
    selecting fills `dl_if`=`ifb4<if>`, `ul_if`=`<if>`; "Create SQM
    instance…" button when none); dl_if / ul_if (free text, overridable);
    adjust_dl/ul; min/base/max DL/UL with validation `0 < min ≤ base ≤ max`;
    `connection_active_thr_kbps`; "Keep SQM base rates in sync" flag.
  - **Pinger & Reflectors**: `pinger_method` (only installed binaries
    selectable, missing ones greyed with install hint); `no_pingers`;
    `reflector_ping_interval_s`; `reflectors` DynamicList;
    `reflectors_url`, `reflectors_url_skip_lines`; `randomize_reflectors`;
    `retain_reflector_stats`; `irtt_session_duration_m`.
    **Probe routing** dropdown: *none* / *mwan3: <iface>* (→
    `ping_prefix_string="mwan3 use <iface> exec"`) / *custom* (free
    `ping_prefix_string` + `ping_extra_args`). Help text states that
    `mwan3 use` works with fping / ping; irtt / tsping need
    `ping_extra_args` or fwmark routing.
  - **Thresholds**: the six OWD thresholds, `alpha_*`, `shaper_rate_*`,
    `bufferbloat_detection_window/thr`, `high_load_thr`,
    `*_refractory_period_ms`.
  - **Reflector health**: all `reflector_*` keys.
  - **Sleep & stall**: `enable_sleep_function`, `sustained_idle_sleep_thr_s`,
    `min_shaper_rates_enforcement`, `stall_detection_thr`,
    `connection_stall_thr_kbps`, `global_ping_response_timeout_s`,
    `startup_wait_s`, `if_up_check_interval_s`,
    `monitor_achieved_rates_interval_ms`, `monitor_cpu_usage_interval_ms`.
  - **Logging**: `output_*`, `debug`, `log_to_file`, `log_file_max_*`,
    `log_file_path_override`, `log_DEBUG_messages_to_syslog`,
    `log_file_export_compress`, `log_file_buffer_timeout_ms`,
    `status_file_interval_ms`.
- Every field shows the `defaults.sh` value as placeholder and the
  `defaults.sh` comment as description. These are generated at build time
  into `cake-autorate/defaults.json` by a small script
  (`openwrt/luci-app-cake-autorate/gen-defaults.sh`) so the UI never drifts
  from `defaults.sh`. Empty field = not stored = default.
- Before Save & Apply: `check_config` per changed instance; errors shown
  at the field. Then standard UCI apply → reload trigger. If "sync base
  rates" is set, `sqm_sync_rates` is called after apply.
- Duplicate `dl_if`/`ul_if` across instances is rejected in validation.

### 10.3 Log (`log.js`)

Instance selector, line count (100/500/2000), auto-refresh (5 s), record
type filter (DEBUG/INFO/SUMMARY/SHAPER/LOAD/REFLECTOR/CPU/ERROR), monospace
view. Buttons: Export (→ `log_export`, then download via `file.read`),
Reset log, Download current log.

### 10.4 MQTT (`mqtt.js`)

Enabled at boot, host / port / user / password, Start / Stop / Restart,
status; warning if no instance has `output_summary_stats=1` (the publisher
needs SUMMARY records) with a one-click "enable summary stats on all
instances"; warning if `mosquitto_pub` is missing.

### 10.5 Overview widget (`75_cake-autorate.js`)

Compact table on the LuCI status page: per instance state, shaper DL/UL,
achieved DL/UL, OWD Δ DL/UL.

### 10.6 i18n

English strings, `po/templates/cake-autorate.pot`, Hungarian `po/hu`.

## 11. Integration details and error handling

SQM:

- Derivation `ul_if = sqm.<id>.interface`, `dl_if = ifb4<interface>`
  (sqm-scripts convention); existence verified via `tc -j qdisc show`;
  custom setups (cake-dual-ifb etc.) may override freely, with a warning
  only.
- `sqm_create` sets qdisc/script/rates/enabled only; link layer and
  overhead are left to `luci-app-sqm` (the UI links there).

Multi-WAN:

- mwan3 interfaces come from `/etc/config/mwan3` `interface` sections.
- Runtime warning in Overview when >1 instance and no probe routing set.

Error handling:

- Instance crash: procd respawns; card shows "crashed / restarting" from
  `service list` (`exit_code`, respawn counters) and links to Log /
  `logread -e cake-autorate.<id>`.
- Running per procd but no `status.json` yet → "starting…" (covers
  `startup_wait_s` and interface waiting).
- `status.json` present but `pid` dead → `stale`, shown as stopped.
- rpcd / ACL errors → `ui.addNotification` with the message, never a
  silently empty page.

## 12. Testing

1. Local (bash under WSL / Git Bash): `shellcheck` on all shell files;
   `uci-to-config.sh` output validated with `cake-autorate.sh
   --check-config` for representative UCI fixtures (lists, floats, empty
   strings, unknown key → error); `status.json` checked with `jq`;
   `bash -n` on the modified main script.
2. CI: SDK build of both packages (`all` arch) for 24.10 and 25.12; a
   broken Makefile fails here.
3. Router (real hardware, OpenWrt 25.12): install `.apk`; migration of an
   existing `/root/cake-autorate` config; single instance up; add + clone
   a second instance; `stop <id>` stops only that one (`ubus call service
   list`); editing one instance restarts only that one; charts under a
   speed test; log export / reset; MQTT publisher; uninstall leaves no
   processes.

## 13. CI / release

`.github/workflows/openwrt-packages.yml`: `openwrt/gh-action-sdk` matrix
over SDK 24.10 (`.ipk`) and 25.12 (`.apk`), `PACKAGES: cake-autorate
luci-app-cake-autorate`, artifacts attached to tagged releases; separate
`shellcheck` job. Package version = `cake_autorate_version` from
`cake-autorate.sh` + fork `PKG_RELEASE`.

## 14. Decisions log

- Base: cake-autorate bash (mature, more pinger methods, multi-WAN
  routing options, logging/MQTT) — not DARKMOON C.
- Status source: script writes `status.json` (1A) — not log parsing.
- UI backend: dedicated rpcd shell plugin (2A) — not raw `file.*` RPCs.
- SQM: integrate (detect, create, sync rates), do not replace.
- Monitoring depth: snapshot + client-side rolling charts (B), no
  server-side history.
- MQTT publisher configurable from LuCI.
- Packages `all` arch; `setup.sh` path untouched for non-OpenWrt users.
