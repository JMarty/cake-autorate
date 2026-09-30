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
3. Never change the upstream rate-control algorithm. Fork hooks in
   cake-autorate.sh / lib.sh / defaults.sh carry a `# fork:` comment.
4. The user works with the superpowers plugin; its plans/specs live in
   docs/superpowers/ and .superpowers/ which are gitignored (local only).

## Current status (update me)
- Released: v3.5.0-owrt3 (backend 3.5.0-r2, LuCI 1.0.0-r1).
- In progress: pre-release hardening (plan: docs/superpowers/plans/2026-09-30-pre-release-hardening.md)
  -> target v3.5.0-owrt4 (backend 3.5.0-r3, LuCI 1.1.0-r1).
- Verified on a real router: OpenWrt 25.12 (apk), 5G WAN, single instance.

## Features
- Native OpenWrt packages: `cake-autorate` (backend) and
  `luci-app-cake-autorate`; `.apk` (25.12+) and `.ipk` (24.10) built by CI.
- UCI config `/etc/config/cake-autorate`: one `instance` section per WAN,
  option names identical to `defaults.sh` variables, reflectors as `list`.
  UCI -> shell config generation (`uci-to-config.sh`), defaults exported as
  JSON (`defaults-to-json.sh`).
- Automatic migration of legacy `setup.sh` installs
  (`/root/cake-autorate/config.*.sh`, incl. MQTT credentials) into UCI.
- One procd instance per WAN (`cake-autorate.init`); stopping or
  reconfiguring one instance leaves the others running (mwan3-friendly).
- Live status: each instance writes `/var/run/cake-autorate/<id>/status.json`
  about once a second.
- `cake-autorate.sh --check-config <file>` validates settings before restart.
- MQTT publisher as a separate service (`mqtt-publisher.init`) configured
  from UCI.
- rpcd/ubus API (`ubus call cake-autorate <method>`): status, defaults,
  instance_control, check_config, log_tail, log_export, log_reset,
  system_info, sqm_create, sqm_sync_rates, mqtt_status.
- LuCI pages (Services -> CAKE Autorate): Overview, Instances, Log, MQTT,
  plus a Status-page widget. Rolling charts with zoom, synced hover and
  dynamic scale; instance grid shows defaults.
- CI: shellcheck, offline test suite, OpenWrt SDK package builds, releases
  from tags.

## Layout
| Path | Responsibility |
|------|----------------|
| cake-autorate.sh, lib.sh, defaults.sh | Upstream core; fork hooks marked `# fork:` |
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

## Dev workflow
- Tests: `wsl bash openwrt/tests/run-tests.sh` (Windows) / `bash openwrt/tests/run-tests.sh`
- Shellcheck: same commands as .github/workflows/openwrt-packages.yml
- JS syntax: `node --check <file>` for every LuCI JS file
- Quick router test of LuCI files: scp -O the changed file(s) to
  /www/luci-static/resources/... then Ctrl+F5.
- Release: bump PKG_RELEASE / PKG_VERSION, update CHANGELOG + README, tag
  `v<core>-owrt<N>`, CI attaches .apk/.ipk + SHA256SUMS to the GitHub release.

## Known limitations / backlog
- Pre-release hardening in progress — see the plan in docs/superpowers/plans/ (local only).
