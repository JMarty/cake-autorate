# CLAUDE.md — cake-autorate OpenWrt fork

## What this repo is
Fork of lynxthecat/cake-autorate (upstream algorithm untouched) that adds:
native OpenWrt packaging (`openwrt/cake-autorate`), UCI config, one procd
instance per WAN, an rpcd/ubus API, and a LuCI web app
(`openwrt/luci-app-cake-autorate`). Public repo: github.com/JMarty/cake-autorate.

## MANDATORY maintenance rules
1. Keep THIS file current: after any change to features, status, layout,
   versions or workflow, update the relevant section below in the same commit.
2. Keep the GitHub-facing docs current: every user-visible change (feature,
   option, UI, install/upgrade step, version) must update README.md (fork
   section) and, if it affects installation, INSTALLATION.md, plus a
   CHANGELOG.md entry under "OpenWrt package / LuCI app".
3. Never change the upstream rate-control algorithm. Mark every NEW fork
   hook in cake-autorate.sh / lib.sh / defaults.sh with a `# fork:` comment.
   Existing fork hooks predating this rule: the status.json writer (lib.sh
   build_status_json/write_status_file*), --check-config (cake-autorate.sh),
   the cleanup run-dir guard, status_file_interval_ms (defaults.sh);
   `git diff ac75f49 -- cake-autorate.sh lib.sh defaults.sh` shows the full
   fork delta against upstream.
4. The user works with the superpowers plugin; its plans/specs live in
   docs/superpowers/ and .superpowers/ which are gitignored (local only).

## Current status (update me)
- Released: v3.5.0-owrt3 (backend 3.5.0-r2, LuCI 1.0.0-r1).
- Pre-release hardening (plan: docs/superpowers/plans/2026-09-30-pre-release-hardening.md)
  Tasks 1-9 done on branch `pre-release-hardening` (code, tests, CI, docs);
  CHANGELOG lists it as "v3.5.0-owrt4 (unreleased)". Final whole-branch
  review fix wave done (check-config log side effect, export dir hardening,
  strict SQM rate sync, r2-backend warning, CI release job, docs).
  Parked review items also fixed: interface clash check ignores disabled
  instances, unused check_config ACL grant / api.checkConfig removed
  (rpcd method kept for CLI), overview version label is a text node.
- Next (Task 10, with the user): on-router checks — incl. a crashed
  instance with log_to_file=1 does not grow /var/log/cake-autorate.log
  (rpcd --check-config polling); `log_export` refuses a pre-made symlinked
  /tmp/cake-autorate-export; LuCI 1.1.0 on an r2 (owrt3) backend shows the
  "backend is older" warning — then add screenshots
  images/luci-overview.png + images/luci-instances.png (referenced by README),
  enable GitHub Issues and private vulnerability reporting (docs link to
  both; currently disabled), merge, tag v3.5.0-owrt4 (backend 3.5.0-r3,
  LuCI 1.1.0-r1), write release notes, drop "(unreleased)" in CHANGELOG.
- Verified on a real router: OpenWrt 25.12 (apk), 5G WAN, single instance.

## Features
- Native OpenWrt packages: `cake-autorate` (backend) and
  `luci-app-cake-autorate`; `.apk` (25.12+) and `.ipk` (24.10) built by CI.
- UCI config `/etc/config/cake-autorate`: one `instance` section per WAN,
  option names identical to `defaults.sh` variables, reflectors as `list`.
  UCI -> shell config generation (`uci-to-config.sh`), defaults exported as
  JSON (`defaults-to-json.sh`). Integer values of float options (e.g. `30`) are
  written as `30.0` so cake-autorate's type check accepts them.
- Automatic migration of legacy `setup.sh` installs
  (`/root/cake-autorate/config.*.sh`, incl. MQTT credentials) into UCI; a failed
  import is logged as failed (not as imported).
- One procd instance per WAN (`cake-autorate.init`); stopping or
  reconfiguring one instance leaves the others running (mwan3-friendly).
- Live status: each instance writes `/var/run/cake-autorate/<id>/status.json`,
  written at a configurable interval (status_file_interval_ms, default
  1000 ms; 0 disables). Written in place with a fork-free builtin printf;
  carries `updated_us`; readers must tolerate an empty/partial file.
- `cake-autorate.sh --check-config <file>` validates settings (incl.
  cross-field relations via `check_config_relations`); it forces
  log_to_file=0/use_logger=0 even after sourcing the config (no side
  effects). The init script does not run it; rpcd `status` runs it for
  crashed instances (config_errors).
- On exit CAKE is reset to the base rates (`reset_shaper_rates_on_exit=1`);
  the run dir is only removed by the process that created it; a missing
  `log_file_path_override` dir falls back to /var/log with a warning.
- MQTT publisher as a separate service (`mqtt-publisher.init`) configured
  from UCI.
- rpcd/ubus API (`ubus call cake-autorate <method>`): status, defaults,
  instance_control, service_control, check_config, log_tail, log_export,
  log_reset, system_info, sqm_create, sqm_sync_rates (CLI only; not in
  the LuCI ACL), mqtt_status.
  `status` adds `config_errors` (check-config result) for enabled, stopped
  instances with a non-zero exit code; `log_export` keeps only the newest
  export per instance in /tmp/cake-autorate-export.
- SQM base-rate sync (`sqm_sync_base_rates`) is done by the init script when
  an instance starts (`sync_sqm_rates`), not by the web UI.
- LuCI pages (Services -> CAKE Autorate): Overview, Instances, Log, MQTT,
  plus a Status-page widget. Rolling charts with zoom, synced hover and
  dynamic scale; instance grid shows defaults. Charts are theme-safe
  (dark mode), keyboard-accessible legend, touch tooltip; stopped/stale
  instances show no data, config errors appear as a card warning, and the
  Status widget hides itself (returns null) when there is nothing to show.
- LuCI Instances page (luci-app 1.1.0): grid columns enabled (inline),
  dl_if, ul_if, base DL/UL rate are also editable in the modal; booleans
  backed by defaults.sh are tri-state (Default / On / Off, `flagOpt`) so
  "off" survives when the built-in default is on; cross-field validation
  (min >= 1, min <= base <= max, connection_active_thr <= min rates,
  dl_if != ul_if, unique interfaces) using sibling form values -> global
  section -> built-in default; add/clone reject invalid, duplicate or
  reserved (`global`, `mqtt`) names, clones are created disabled without
  interfaces/SQM link; "Create SQM instance…" sits above the map; plain
  LuCI save/apply (no custom handleSaveApply). Warns when the backend has
  no `defaults` metadata.
- LuCI talks only to the `cake-autorate` ubus object (service start/stop via
  `service_control`, log download via cgi-download from
  /tmp/cake-autorate-export); cgi-download needs both the `cgi-io`
  `download` grant and the `file` read grant on
  `/tmp/cake-autorate-export/*` (cgi-io checks the former first). The ACL
  grants no `luci`/`file`/`service` ubus objects and no `sqm`/`mwan3` UCI
  access.
- CI: shellcheck (core and tests at -S warning, package scripts), node --check of
  LuCI JS, offline test suite, OpenWrt SDK package builds (SDK action pinned by
  SHA, least-privilege permissions), releases + SHA256SUMS from tags.

## Layout
| Path | Responsibility |
|------|----------------|
| cake-autorate.sh, lib.sh, defaults.sh | Upstream core; new fork hooks marked `# fork:` |
| openwrt/cake-autorate/Makefile | Backend package definition |
| openwrt/cake-autorate/files/cake-autorate.config | Default UCI config |
| openwrt/cake-autorate/files/cake-autorate.defaults | uci-defaults (first-install migration) |
| openwrt/cake-autorate/files/cake-autorate.init | procd init, one instance per WAN |
| openwrt/cake-autorate/files/mqtt-publisher.init | MQTT publisher service |
| openwrt/cake-autorate/files/uci-to-config.sh | UCI -> instance shell config |
| openwrt/cake-autorate/files/defaults-to-json.sh | defaults.sh -> JSON |
| openwrt/cake-autorate/files/migrate-legacy-config.sh | Legacy config -> UCI |
| openwrt/cake-autorate/files/rpcd-cake-autorate | rpcd/ubus API |
| openwrt/luci-app-cake-autorate/Makefile | LuCI package definition |
| .../htdocs/luci-static/resources/cake-autorate/{api,charts}.js | RPC wrappers, chart library |
| .../resources/view/cake-autorate/{overview,instances,log,mqtt}.js | LuCI views |
| .../resources/view/status/include/75_cake-autorate.js | Status-page widget |
| .../root/usr/share/luci/menu.d, rpcd/acl.d | Menu and ACL JSON |
| openwrt/tests/ | Offline tests (run-tests.sh, test_*.sh, fixtures/, shim/); router/smoke.sh runs on a device |
| .github/workflows/openwrt-packages.yml | CI: lint, tests, SDK builds, release |
| .github/ISSUE_TEMPLATE/ | Bug report form (versions, ubus status, logread) + contact links (upstream forum, security advisory) |
| README.md | Fork section: features, LuCI pages, screenshots, versioning table, reporting, security note; rest is upstream text |
| INSTALLATION.md | Package install/configure/verify/migrate/upgrade/uninstall/rollback/troubleshooting/trust first; upstream setup.sh sections labelled "(setup.sh installs only)" |
| CHANGELOG.md | "OpenWrt package / LuCI app (fork)" section on top (per owrt release), upstream history below |
| CONTRIBUTING.md, SECURITY.md | Dev checks, coding rules, commit style; private vulnerability reporting + by-design security notes |

## Dev workflow
- Tests: `wsl bash openwrt/tests/run-tests.sh` (Windows) / `bash openwrt/tests/run-tests.sh`
- Shellcheck: same commands as .github/workflows/openwrt-packages.yml (core: `shellcheck -x cake-autorate.sh lib.sh -S warning`; tests: `shellcheck -x openwrt/tests/*.sh -S warning`)
- JS syntax: `node --check <file>` for every LuCI JS file
- Quick router test of LuCI files: scp -O the changed file(s) to
  /www/luci-static/resources/... then Ctrl+F5.
- Release: bump PKG_RELEASE / PKG_VERSION, update CHANGELOG + README, tag
  `v<core>-owrt<N>`. The build matrix only uploads artifacts (contents: read);
  a tag-only `release` job (the only job with contents: write) downloads them,
  computes SHA256SUMS and attaches packages + SHA256SUMS in one step. Refresh
  the pinned action SHAs deliberately (`gh api repos/openwrt/gh-action-sdk/commits/main --jq .sha`,
  `gh api repos/softprops/action-gh-release/commits/v2 --jq .sha`).

## Known limitations / backlog
- No translations yet (no po/ directory); strings are all wrapped in _().
- Packages are unsigned (apk needs --allow-untrusted; SHA256SUMS published).
- --check-config does not yet cover post-exit checks (log_file_buffer_timeout_ms < 50,
  reflector syntax/duplicates).
- rpcd/init: `uci commit sqm` also commits unrelated staged sqm edits;
  service_control returns ok on init failure; check_config is not cached
  (one --check-config run per crashed instance per poll); sqm sync reloads
  all of sqm, not just the linked interface.
- Tests: no coverage for rpcd runtime paths, tc reset, log override fallback,
  LuCI JS helpers.
- CI: node --check step passes on an empty file list.
