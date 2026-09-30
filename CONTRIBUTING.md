# Contributing

Thank you for helping! This repository is a fork of
[lynxthecat/cake-autorate](https://github.com/lynxthecat/cake-autorate)
that adds OpenWrt packaging and a LuCI web interface. Please keep in
mind where a change belongs:

- **Rate-control algorithm, pinger parsing, tuning defaults** — these
  come from upstream and are deliberately left unchanged here. Propose
  such changes upstream (pull request to lynxthecat/cake-autorate, or
  the [OpenWrt forum thread](https://forum.openwrt.org/t/cake-w-adaptive-bandwidth/191049)).
- **OpenWrt packages, init scripts, UCI handling, rpcd API, LuCI app,
  CI, documentation** — welcome here, as issues or pull requests.

## Repository layout

| Path | What it is |
|------|------------|
| `cake-autorate.sh`, `lib.sh`, `defaults.sh` | Upstream core. Fork additions are small hooks; mark new ones with a `# fork:` comment. |
| `openwrt/cake-autorate/` | Backend package: Makefile, init scripts, UCI helpers, rpcd plugin |
| `openwrt/luci-app-cake-autorate/` | LuCI web interface (JavaScript views, menu, ACL) |
| `openwrt/tests/` | Offline test suite (`run-tests.sh`), fixtures, and `router/smoke.sh` for a real device |
| `.github/workflows/openwrt-packages.yml` | CI: lint, tests, package builds, releases |

## Checks to run before a pull request

CI runs the same checks; running them locally saves a round trip.
On Windows, prefix the commands with `wsl` (or run them in a WSL shell).

```sh
# offline test suite (needs bash and jq)
bash openwrt/tests/run-tests.sh

# shellcheck, exactly as in CI
shellcheck -x openwrt/cake-autorate/files/uci-to-config.sh openwrt/cake-autorate/files/migrate-legacy-config.sh openwrt/cake-autorate/files/defaults-to-json.sh
shellcheck -s sh -e SC1091 openwrt/cake-autorate/files/cake-autorate.init openwrt/cake-autorate/files/mqtt-publisher.init openwrt/cake-autorate/files/cake-autorate.defaults openwrt/cake-autorate/files/rpcd-cake-autorate
shellcheck -x cake-autorate.sh lib.sh -S warning
shellcheck -x openwrt/tests/*.sh -S warning

# JavaScript syntax of the LuCI app
find openwrt/luci-app-cake-autorate -name '*.js' -exec node --check {} \;
```

Coding rules:

- Scripts starting with `#!/usr/bin/env bash` may use bash. The init
  scripts, `cake-autorate.defaults` and `rpcd-cake-autorate` run under
  BusyBox `ash` and must stay POSIX `sh`.
- Do not add per-cycle `fork`/`exec` (subshells, external commands) to
  the main loop of `cake-autorate.sh`; it runs many times per second on
  small routers.
- LuCI JavaScript: ES5 style like the existing files (`var`,
  `function`); wrap every user-visible string in `_()` and use
  `.format()` for placeholders (never concatenate translated pieces);
  do not hardcode light backgrounds or dark text colours, so the pages
  work with dark themes.
- Add or update tests in `openwrt/tests/` for behaviour you change.

## Quick test on a router

For LuCI changes you can copy the changed files straight to a test
router (OpenWrt's SSH server needs `scp -O`) and reload the page with
Ctrl+F5:

```sh
scp -O openwrt/luci-app-cake-autorate/htdocs/luci-static/resources/view/cake-autorate/overview.js \
    root@192.168.1.1:/www/luci-static/resources/view/cake-autorate/
```

Backend scripts go to `/usr/lib/cake-autorate/`, the rpcd plugin to
`/usr/libexec/rpcd/cake-autorate` (then `service rpcd reload`).
`openwrt/tests/router/smoke.sh <instance-id>` runs a quick check of the
ubus API on the router. For anything larger, build the packages (CI
does this on every push; the built files are available as workflow
artifacts) and install them as described in
[INSTALLATION](./INSTALLATION.md#installation-as-an-openwrt-package-recommended-on-openwrt).

## Commits and pull requests

- One topic per commit; the subject line is a short imperative
  sentence (e.g. "Fix log export when the log is empty"), optionally
  prefixed with the area ("LuCI overview: …", "CI: …").
- Every user-visible change (feature, option, UI, install or upgrade
  step) also updates `README.md` (fork section), `INSTALLATION.md` if
  installation is affected, and `CHANGELOG.md` under
  "OpenWrt package / LuCI app (fork)".
- `CLAUDE.md` is the maintainer's project guide (also used by AI
  coding assistants); keep its status, features and layout sections
  current when you change them.
- Do not bump package versions in pull requests; the maintainer does
  that when preparing a release.

## Translations

The web interface is English only at the moment. All strings are
already marked for translation, so `po/` files for
`luci-app-cake-autorate` are welcome.
