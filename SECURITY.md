# Security policy

## Scope

This policy covers what this fork adds: the OpenWrt packages
`cake-autorate` and `luci-app-cake-autorate` (init scripts, UCI
handling, the rpcd/ubus API, the LuCI web interface and its access
rules) and the release process. Issues in the upstream cake-autorate
algorithm scripts are also welcome here if they affect the packages;
they will be forwarded upstream where appropriate.

## Supported versions

Only the latest release on the
[Releases page](https://github.com/JMarty/cake-autorate/releases)
receives fixes. Please check that the problem still exists there.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through GitHub: open the repository's
**Security** tab and click **Report a vulnerability** (GitHub private
vulnerability reporting). Include the package versions
(`apk info -v | grep cake` or `opkg list-installed | grep cake`), the
OpenWrt version and the steps to reproduce.

If that button is not available, open a short public issue that only
asks for a private contact — without any details of the problem.

This project is maintained by a volunteer, so please allow some time
for a reply. Fixes are published as a new release; tell us if you
would like to be credited in the changelog.

## Known, by-design behaviour

These are documented properties, not vulnerabilities:

- **Write access to this app equals root access.** The option
  `ping_prefix_string` is executed as a command prefix by the service,
  which runs as root. Anyone who can change `/etc/config/cake-autorate`
  (in LuCI with write access to this app, or with `uci`) can therefore
  run commands as root. Grant write access only to administrators.
- **The MQTT password is stored in plain text** in
  `/etc/config/cake-autorate` and is readable by LuCI users with read
  access to this app, and by anyone who can read that file or a
  configuration backup.
- **The packages are not signed** with an OpenWrt key and need
  `apk add --allow-untrusted`. Verify downloads with the `SHA256SUMS`
  file of the release (see
  [INSTALLATION](./INSTALLATION.md#trust-and-verification)).
