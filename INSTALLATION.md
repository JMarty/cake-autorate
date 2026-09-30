# Installing cake-autorate

**cake-autorate** is a script that minimizes latency by adjusting CAKE
bandwidth settings based on traffic load and round-trip time
measurements. See the main [README](./README.md) page for more details
of the algorithm.

There are two ways to install cake-autorate:

- **OpenWrt 24.10 or newer:** install the prebuilt packages of this
  fork (recommended) — see the next section. You get a normal OpenWrt
  service, UCI configuration and, optionally, a LuCI web interface.
- **Older OpenWrt, Asus Merlin, Debian/Ubuntu:** use the upstream
  `setup.sh` installer — see
  [Installation Steps (OpenWrt, setup.sh)](#installation-steps-openwrt-setupsh-installs-only)
  and the sections after it. Sections marked "(setup.sh installs only)"
  do not apply to the package.

## Installation as an OpenWrt package (recommended on OpenWrt)

### Before you start

- CAKE must already be running on your WAN interface. The usual way
  is SQM: install `luci-app-sqm`, then create and enable a queue with
  the `cake` queueing discipline on your WAN interface, as described in the
  [OpenWrt SQM documentation](https://openwrt.org/docs/guide-user/network/traffic-shaping/sqm).
  (The web interface can also create a matching SQM queue for you:
  **Create SQM instance…** on the Instances page.)
- You need [SSH access to the router](https://openwrt.org/docs/guide-quick-start/sshadministration).
  The packages cannot be installed through LuCI's
  *System → Software → Upload Package* (see [Troubleshooting](#troubleshooting)).
- Find out which package manager your router uses: if the `apk`
  command exists, you have OpenWrt 25.12 or newer and need the `.apk`
  files; if `opkg` exists, you have OpenWrt 24.10 and need the `.ipk`
  files. (`cat /etc/openwrt_release` shows the version.)

Both packages are architecture-independent (`all`): the same files
work on every router model. Dependencies (`bash`, `fping`,
`sqm-scripts`, `jsonfilter`, and `luci-base` for the web interface)
are installed automatically from the OpenWrt package feeds.

### Install

The file names contain the version, so there is no fixed "latest"
download link. Open the [Releases page](https://github.com/JMarty/cake-autorate/releases),
pick the newest release and use its file names. The commands below
use the names of release **v3.5.0-owrt4**; for a newer release,
replace the tag and the file names accordingly.

**OpenWrt 25.12 or newer (apk):**

```sh
apk update
cd /tmp
wget https://github.com/JMarty/cake-autorate/releases/download/v3.5.0-owrt4/cake-autorate-3.5.0-r3.apk
wget https://github.com/JMarty/cake-autorate/releases/download/v3.5.0-owrt4/luci-app-cake-autorate-1.1.0-r1.apk
apk add --allow-untrusted ./cake-autorate-3.5.0-r3.apk
apk add --allow-untrusted ./luci-app-cake-autorate-1.1.0-r1.apk
service rpcd reload
```

**OpenWrt 24.10 (opkg):**

```sh
opkg update
cd /tmp
wget https://github.com/JMarty/cake-autorate/releases/download/v3.5.0-owrt4/cake-autorate_3.5.0-r3_all.ipk
wget https://github.com/JMarty/cake-autorate/releases/download/v3.5.0-owrt4/luci-app-cake-autorate_1.1.0-r1_all.ipk
opkg install ./cake-autorate_3.5.0-r3_all.ipk
opkg install ./luci-app-cake-autorate_1.1.0-r1_all.ipk
service rpcd reload
```

The `luci-app-cake-autorate` package (the web interface) is optional;
the `cake-autorate` package works on its own from the command line.
`--allow-untrusted` is needed because the packages are not signed —
see [Trust and verification](#trust-and-verification).

After installing the web interface, **log out of LuCI and log in
again** so the new menu and permissions take effect. The pages are
under **Services → CAKE Autorate**.

### Configure

**With the web interface:** go to *Services → CAKE Autorate →
Instances*, edit the `primary` instance (or add one), set the download
and upload interfaces (e.g. `ifb4wan` and `wan` for an SQM queue on
`wan`) and the minimum / base / maximum rates in kbit/s, tick
*Enabled*, then *Save & Apply*. The Overview page then shows the live
charts.

**From the command line:** the configuration lives in
`/etc/config/cake-autorate` — one `instance` section per WAN, option
names identical to the variables in
[`defaults.sh`](./defaults.sh), arrays (`reflectors`) as `list`
entries, and an optional `global` section whose values apply to all
instances. The package ships a disabled `primary` instance:

```sh
uci set cake-autorate.primary.dl_if='ifb4wan'   # CAKE download (ingress) interface
uci set cake-autorate.primary.ul_if='wan'       # CAKE upload interface
uci set cake-autorate.primary.min_dl_shaper_rate_kbps='5000'
uci set cake-autorate.primary.base_dl_shaper_rate_kbps='20000'
uci set cake-autorate.primary.max_dl_shaper_rate_kbps='80000'
uci set cake-autorate.primary.min_ul_shaper_rate_kbps='5000'
uci set cake-autorate.primary.base_ul_shaper_rate_kbps='20000'
uci set cake-autorate.primary.max_ul_shaper_rate_kbps='35000'
uci set cake-autorate.primary.enabled='1'
uci commit cake-autorate
service cake-autorate enable
service cake-autorate reload
```

`tc qdisc ls` shows the interfaces on which CAKE runs. See
[Setting the bandwidth](./README.md#the-solution-set-cake-parameters-based-on-load-and-latency)
in the README for how to choose the three rates, and
[Configuration of cake-autorate](#configuration-of-cake-autorate) below
for the other settings (use them as UCI options with the same names).

Each instance is a separate procd instance:

- `service cake-autorate reload` — (re)starts only instances whose
  configuration changed, or that are not running.
- `service cake-autorate stop <id>` — stops one instance (until the
  next reload/restart); `service cake-autorate stop` stops all.
- `service cake-autorate restart` — restarts all instances.

When an instance stops, CAKE is set back to its base rates
(`reset_shaper_rates_on_exit`, default on). If you enable
`sqm_sync_base_rates` for an instance that is linked to an SQM queue
(`sqm_instance`), the service writes the instance's base rates into
that SQM queue each time the instance starts. With `manage_sqm='1'`
the service also switches the instance's SQM queue (the linked one,
else the first queue on its upload interface) on with CAKE when the
instance starts, and off when it stops.

### Verify

```sh
service cake-autorate status          # is the service running?
ubus call cake-autorate status        # live status of every instance as JSON
logread -e cake-autorate              # service messages and errors
```

In `ubus call cake-autorate status`, a running instance shows
`"running": true` and a `status` object with the current rates. An
enabled instance that failed to start shows `config_errors` explaining
which setting is wrong (the Overview page shows the same message).
The detailed log of an instance is in
`/var/log/cake-autorate.<id>.log` (if `log_to_file` is on) and on the
*Log* page of the web interface.

### Migration from a setup.sh install

If `/root/cake-autorate/config.*.sh` files from an earlier `setup.sh`
install exist when the package is installed, they are imported
automatically:

- each `config.<id>.sh` becomes a UCI instance `<id>` (the packaged
  `primary` default is replaced by your `config.primary.sh`), and the
  MQTT publisher settings are imported as well;
- the old launcher is stopped, and the packaged init script replaces
  the one `setup.sh` generated;
- each imported instance is enabled if the old service was enabled at
  boot;
- the result is written to the system log
  (`logread -e cake-autorate`).

The import runs **once**: afterwards `cake-autorate.global.legacy_migrated`
is set to `1`, and later package upgrades do not touch your UCI
settings again. Once you have checked the imported settings, the old
directory `/root/cake-autorate` is no longer used and can be deleted
(also remove it from *System → Backup / Flash Firmware →
Configuration* if you added it there). To repeat the import, delete
the marker and then reinstall or upgrade the `cake-autorate` package:

```sh
uci delete cake-autorate.global.legacy_migrated
uci commit cake-autorate
```

A repeated import only replaces `primary`: a legacy `config.<id>.sh`
whose instance `<id>` already exists in UCI is skipped (logged), so
delete those instances first if you want them re-imported. The marker
is set again only when legacy `config.*.sh` files were found.

### Upgrade

Download the files of the new release and install them exactly as in
[Install](#install) (`apk add --allow-untrusted ./<file>.apk` or
`opkg install ./<file>.ipk` with the new file names; install both
packages from the same release). Your settings in
`/etc/config/cake-autorate` are kept. Afterwards:

```sh
service rpcd reload
service cake-autorate restart
```

and log out of LuCI and back in. If the browser still shows the old
pages, reload them with Ctrl+F5.

### Uninstall

```sh
apk del luci-app-cake-autorate cake-autorate      # OpenWrt 25.12+
opkg remove luci-app-cake-autorate cake-autorate  # OpenWrt 24.10
```

The service is stopped first, and each running instance sets CAKE back
to its base rates, so SQM keeps shaping at a sensible fixed rate.
`/etc/config/cake-autorate` is left in place; delete it yourself if you
do not plan to reinstall. SQM itself is not touched.

### Rollback to setup.sh

To go back to the upstream script install: uninstall both packages as
above, then follow
[Installation Steps (OpenWrt, setup.sh)](#installation-steps-openwrt-setupsh-installs-only).
If `/root/cake-autorate` still exists, `setup.sh` offers to keep your
old configuration files. Settings you made in UCI/LuCI after the
migration are not copied back; transfer them to
`/root/cake-autorate/config.<id>.sh` by hand.

### Troubleshooting

- **`UNTRUSTED signature` when uploading the package in LuCI**
  (*System → Software → Upload Package*): LuCI cannot install unsigned
  packages. Install from SSH with the commands above.
- **An instance does not start / stops right away:** open the
  Overview page — it shows the configuration error of a crashed
  instance — or run `ubus call cake-autorate status` and look at
  `config_errors`. `logread -e cake-autorate` shows the same messages.
- **"Not shaping — no CAKE qdisc" / "no CAKE qdisc on …":**
  cake-autorate only adjusts an existing CAKE queue; it does not create
  one. The SQM line on the instance's Overview card shows what is
  missing: no SQM queue on the upload interface (use **Create SQM
  instance…** on the Instances page), a disabled queue, or a queue with
  another qdisc (both fixed by **Enable SQM**, which switches the queue
  on with CAKE). Also check that the download/upload interfaces match
  the SQM queue (`tc qdisc ls` shows where CAKE runs; the download
  side is usually `ifb4<wan>`).
- **SQM switches off when cake-autorate stops:** that is what the
  instance option *Let cake-autorate switch SQM on and off*
  (`manage_sqm`, SQM tab) does. Starting the instance switches its SQM
  queue on with CAKE; `service cake-autorate stop [<id>]`, disabling
  the instance or removing the package switch it off, so there is no
  traffic shaping at all while cake-autorate is stopped. A restart
  switches it off and on again; a reboot leaves it as it is. Turn the
  option off to keep SQM running on its own; switching SQM off by hand
  while the option is on is undone by the next start or reload.
- **The menu Services → CAKE Autorate is missing, or pages show
  "Access denied" / permission errors:** run `service rpcd reload`,
  clear the LuCI cache with `rm -rf /tmp/luci-*`, then log out of LuCI
  and back in.
- **"The installed cake-autorate backend is older than this web
  interface":** upgrade the `cake-autorate` package to the version
  from the same release as `luci-app-cake-autorate`.
- **Pinger method not installed:** the default pinger is `fping`
  (installed as a dependency). Other methods such as `tsping` or
  `irtt` need their own packages — see
  [Selecting a pinger method](#selecting-a-pinger-method).

### Trust and verification

The packages are built from this repository by GitHub Actions (see
`.github/workflows/openwrt-packages.yml`) and attached to the release
together with a `SHA256SUMS` file. They are **not signed** with an
OpenWrt signing key, which is why `apk` needs `--allow-untrusted`
(`opkg` installs local unsigned files without an extra option). To
check that the files you downloaded match the ones built by CI,
download `SHA256SUMS` from the same release into the same directory
and run:

```sh
cd /tmp
wget https://github.com/JMarty/cake-autorate/releases/download/v3.5.0-owrt4/SHA256SUMS
grep -F -e cake-autorate-3.5.0-r3.apk -e luci-app-cake-autorate-1.1.0-r1.apk SHA256SUMS > sums.txt
sha256sum -c sums.txt
```

(For `.ipk` files, use their names in the `grep` line.) Each file must
report `OK`.

## Installation Steps (OpenWrt) (setup.sh installs only)

On OpenWrt 24.10 or newer, the
[package installation](#installation-as-an-openwrt-package-recommended-on-openwrt)
above is recommended instead. The `setup.sh` installer below comes
from upstream and installs the upstream version.

cake-autorate provides an installation script that installs all the
required tools. To use it:

- Install SQM (`luci-app-sqm`) and enable and configure `cake` Queue
  Discipline on the interface(s) as described in the
  [OpenWrt SQM documentation](https://openwrt.org/docs/guide-user/network/traffic-shaping/sqm)

- Alternatively, and especially if you may have more complex
  networking needs:

  - DSCPs - consider
    [cake-simple-qos](https://github.com/lynxthecat/cake-qos-simple);
  - WireGuard with PBR - consider
    [cake-dual-ifb](https://github.com/lynxthecat/cake-dual-ifb).

- [SSH into the router](https://openwrt.org/docs/guide-quick-start/sshadministration)

- Ensure `bash` and `fping` are installed.

  On most OpenWrt installations, you can install them by running:

  ```bash
  opkg update
  opkg install bash fping
  ```

  If the `opkg` command is not found, you may need to use `apk`
  instead:

  ```bash
  apk update
  apk add bash fping
  ```

- Use the installer script by copying and pasting each of the commands
  below. The commands retrieve the current version from this repo:

  ```bash
  wget -O /tmp/cake-autorate_setup.sh https://raw.githubusercontent.com/lynxthecat/cake-autorate/master/setup.sh
  sh /tmp/cake-autorate_setup.sh
  ```

- The installer script will detect a previous configuration file, and
  ask whether to preserve it.


## Installation Steps (Asus Merlin)

- From the Asus Merlin GUI: enable adaptive QOS and select cake.

- [SSH into the router](https://github.com/RMerl/asuswrt-merlin.ng/wiki/SSHD)

- Make sure these are installed: entware; coreutils-mktemp; jsonfilter; bash;
  and iputils-ping or fping.

  - Firstly, if not already installed,
    [install entware](https://github.com/RMerl/asuswrt-merlin.ng/wiki/Entware);
  - and then run:

  ```bash
  opkg update
  opkg install coreutils-mktemp jsonfilter bash fping
  ```

- Use the installer script by copying and pasting each of the commands
  below. The commands retrieve the current version from this repo:

  ```bash
  wget -O /tmp/cake-autorate_setup.sh https://raw.githubusercontent.com/lynxthecat/cake-autorate/master/setup.sh
  sh /tmp/cake-autorate_setup.sh
  ```

## Installation on Debian/Ubuntu

- Set up [cake-on-wan](https://github.com/sbivol/cake-on-wan)

- Install prerequisites:

  ```bash
  sudo apt install fping jq
  ```

- Install cake-autorate:

  ```bash
  wget -O /tmp/cake-autorate_setup.sh https://raw.githubusercontent.com/lynxthecat/cake-autorate/master/setup.sh
  sudo sh /tmp/cake-autorate_setup.sh
  ```

- Enable the service (assuming your WAN link is _wan1_):

  ```bash
  sudo systemctl enable cake-autorate@wan1.service
  ```

- Change the configuration and restart the service:

  ```bash
  sudo cp /etc/cake-autorate/config.{primary,wan1}.sh
  sudoedit /etc/cake-autorate/config.wan1.sh
  sudo systemctl restart cake-autorate@wan1.service
  ```

For multiple WAN interfaces, enable additional services and duplicate the configuration:

  ```bash
  sudo cp /etc/cake-autorate/config.wan{1,2}.sh
  sudoedit /etc/cake-autorate/config.wan2.sh
  sudo systemctl enable --now cake-autorate@wan2.service
  ```

## Initial Configuration Steps (OpenWrt and Asus Merlin) (setup.sh installs only)

- For a fresh install, you will need to undertake the following steps.

- Edit the _config.primary.sh_ script using vi or nano to set the
  configuration parameters below (see comments in _config.primary.sh_
  for details).

  - **OpenWrt:** in the _/root/cake-autorate_ directory
  - **Asus Merlin:** in the _/jffs/configs/cake-autorate_ directory

In the configuration file:

- Change `dl_if` and `ul_if` to match the names of the upload and
  download interfaces to which CAKE is applied.

  | Variable | Setting                                          |
  | -------: | :----------------------------------------------- |
  |  `dl_if` | Interface that downloads data (often _ifb4-wan_) |
  |  `ul_if` | Interface that uploads (often _wan_)             |

- For OpenWrt installations, these can be obtained, for example, by
  consulting the configured SQM settings in LuCi or by examining the
  output of `tc qdisc ls`.

- For Asus Merlin the requisite interfaces can also be obtained by
  examining the output of `tc qdisc ls`. These are most likely:

  ```bash
  dl_if=ifb4eth0 # download interface
  ul_if=eth0     # upload interface
  ```

- Choose whether cake-autorate should adjust the shaper rates (disable
  for monitoring only):

  |                Variable | Setting                                    |
  | ----------------------: | :----------------------------------------- |
  | `adjust_dl_shaper_rate` | enable (1) or disable (0) download shaping |
  | `adjust_ul_shaper_rate` | enable (1) or disable (0) upload shaping   |

- Set bandwidth variables as described in _config.primary.sh_.

  | Type | Download                   | Upload                     |
  | ---: | :------------------------- | :------------------------- |
  | Min. | `min_dl_shaper_rate_kbps`  | `min_ul_shaper_rate_kbps`  |
  | Base | `base_dl_shaper_rate_kbps` | `base_ul_shaper_rate_kbps` |
  | Max. | `max_dl_shaper_rate_kbps`  | `max_ul_shaper_rate_kbps`  |

- Set connection idle variable as described in _config.primary.sh_.

  |                     Variable | Setting                                                  |
  | ---------------------------: | :------------------------------------------------------- |
  | `connection_active_thr_kbps` | threshold in Kbit/s below which dl/ul is considered idle |

## Configuration of cake-autorate

cake-autorate is highly configurable and almost every aspect of it can
be (and is ideally) fine-tuned.

> **Package installs:** the variables below are set as UCI options
> with the same names in `/etc/config/cake-autorate` (for example
> `uci set cake-autorate.primary.dl_owd_delta_delay_thr_ms='100'`), or
> on the Instances page of the web interface, instead of in
> _config.primary.sh_. Whole numbers are accepted for decimal settings.

- The file _defaults.sh_ has sensible default settings. After
  cake-autorate has been installed, you may wish to override some of
  these by providing corresponding entries inside _config.primary.sh_.

  - For example, to set a different `dl_owd_delta_delay_thr_ms`, then 
    add a line to the config file _config.primary.sh_ like:

    ```bash
    dl_owd_delta_delay_thr_ms=100.0
    ```

- Users are encouraged to look at _defaults.sh_, which documents the
  many configurable parameters of cake-autorate.

- The type of variable: integer, float, string used in any config file
  must reflect the same type used in _defaults.sh_, and otherwise 
  cake-autorate will throw an error on startup.

  ## Delay thresholds

  - At least the following variables relating to the delay thresholds
    may warrant overriding depending on the connection particulars.

    |                  Variable | Setting                                                                                                      |
    | ------------------------: | :----------------------------------------------------------------------------------------------------------- |
    |                  `dl_owd_delta_delay_thr_ms` | extent of download OWD increase to classify as a delay                                                       |
    |                  `ul_owd_delta_delay_thr_ms` | extent of upload OWD increase to classify as a delay                                                         |
    |      `dl_avg_owd_delta_max_adjust_up_thr_ms` | average download OWD threshold across reflectors at which maximum upward shaper rate adjustment is applied   |
    |      `ul_avg_owd_delta_max_adjust_up_thr_ms` | average upload OWD threshold across reflectors at which maximum upward shaper rate adjustment is applied     |
    |    `dl_avg_owd_delta_max_adjust_down_thr_ms` | average download OWD threshold across reflectors at which maximum downward shaper rate adjustment is applied |
    |    `ul_avg_owd_delta_max_adjust_down_thr_ms` | average upload OWD threshold across reflectors at which maximum downward shaper rate adjustment is applied   |


    An OWD measurement to an individual reflector that exceeds
    `xl_owd_delta_delay_thr_ms` from its baseline is classified as a 
    delay. Bufferbloat is detected when there are 
    `bufferbloat_detection_thr` delays out of the last
    `bufferbloat_detection_window` reflector responses. 

    Prior to bufferbloat detection, the extent of the average OWD
    delta taken across the reflectors governs how much the shaper
    rate is adjusted up. The adjustment is scaled linearly from 
    `shaper_rate_max_adjust_up_load_high` (at or below
    xl_avg_owd_delta_max_adjust_up_thr_ms)
    to `shaper_rate_min_adjust_up_load_high` (at 
    xl_owd_delta_thr_ms).

    Upon bufferbloat detection, the extent of the average OWD delta 
    taken across the reflectors governs how much the shaper rate is 
    adjusted down. The adjustment is scaled linearly from 
    `shaper_rate_min_adjust_down_bufferbloat` (at
    xl_owd_delta_thr_ms) 
    to `shaper_rate_min_adjust_down_bufferbloat` (at or above
    xl_avg_owd_delta_max_adjust_down_thr_ms).
    
    Avoiding bufferbloat requires throttling the connection, and thus
    there is a trade-off between bandwidth and latency.

    The delay thresholds affect how much the shaper rate is punished
    responsive to latency increase. Users that want very low latency
    at all times (at the expense of bandwidth) will want lower values.
    Users that can tolerate higher latency excursions (facilitating
    greater bandwidth).

    Although the default parameters have been designed to offer
    something that might work out of the box for certain connections,
    some analysis is likely required to optimize cake-autorate for the
    specific use-case.

    Read about this in the [ANALYSIS](./ANALYSIS.md) page.

    ## Reflectors

  - Additionally, the following variables relating to reflectors may
    also warrant overriding:

    |                  Variable | Setting                                 |
    | ------------------------: | :-------------------------------------- |
    |              `reflectors` | list of reflectors                      |
    |              `no_pingers` | number of reflectors to ping            |
    | `reflector_ping_interval` | interval between pinging each reflector |

    Reflector choice is a crucial parameter for cake-autorate.

    By default, cake-autorate sends ICMPs to various large anycast DNS
    hosts (Cloudflare, Google, Quad9, etc.).

    It is the responsibility of the user to ensure that the configured
    reflectors provide stable, low-latency responses.

    Some governments appear to block DNS hosts like Google. Users
    affected by the same will need to determine appropriate
    alternative reflectors.

    cake-autorate monitors the responses from reflectors and
    automatically kicks out bad reflectors. The parameters governing
    the same are configurable in the config file (see _defaults.sh_).

    ## Logging

  - The following variables control logging:

    |                       Variable | Setting                                                                                                                                                                                   |
    | -----------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    |      `output_processing_stats` | If non-zero, log the results of every iteration through the process                                                                                                                       |
    |            `output_load_stats` | If non-zero, log the log the measured achieved rates of upload and download                                                                                                               |
    |       `output_reflector_stats` | If non-zero, log the statistics generated in respect of reflector health monitoring                                                                                                       |
    |         `output_summary_stats` | If non-zero, log a summary with the key statistics                                                                                                                                        |
    |          `output_cake_changes` | If non-zero, log when changes are made to CAKE settings via `tc` - this shows when cake-autorate is adjusting the shaper                                                                  |
    |             `output_cpu_stats` | If non-zero, monitor and log CPU usage percentages across the detected cores                                                                                                              |
    |         `output_cpu_raw_stats` | If non-zero, log the raw CPU usage lines obtained during CPU usage monitoring                                                                                                              |
    |                        `debug` | If non-zero, debug lines will be output                                                                                                                                                   |
    | `log_DEBUG_messages_to_syslog` | If non-zero, log lines will also get sent to the system log                                                                                                                               |
    |                  `log_to_file` | If non-zero, log lines will be sent to /tmp/cake-autorate.log regardless of whether printing to console `log_file_max_time_mins` have elapsed or `log_file_max_size_KB` has been exceeded |
    |       `log_file_max_time_mins` | Number of minutes to elapse between log file rotaton                                                                                                                                      |
    |         `log_file_max_size_KB` | Number of KB (i.e. bytes/1024) worth of log lines between log file rotations                                                                                                              |

## Manual testing (setup.sh installs only)

To start the `cake-autorate.sh` script and watch the logged output as
it adjusts the CAKE parameters, run these commands:

```bash
cd /root/cake-autorate     # to the cake-autorate directory
./cake-autorate.sh
```

- Monitor the script output to see how it adjusts the download and
  upload rates as you use the connection.
- Press ^C to halt the process.

## Install as a service (OpenWrt) (setup.sh installs only)

You can install cake-autorate as a service that starts up the autorate
process whenever the router reboots. To do this:

- [SSH into the router](https://openwrt.org/docs/guide-quick-start/sshadministration)

- Run these commands to enable and start the service file:

  ```bash
  # the setup.sh script already installed the service file
  service cake-autorate enable
  service cake-autorate start
  ```

If you edit any of the configuration files, you will need to restart
the service with `service cake-autorate restart`

When running as a service, the `cake-autorate.sh` script outputs to
_/var/log/cake-autorate.primary.log_ (observing the instance
identifier _cake-autorate_config.identifier.sh_ set in the config file
name).

WARNING: Take care to ensure sufficient free memory exists on router
to handle selected logging parameters. Consider disabling logging or
adjusting logging parameters such as `log_file_max_time_mins` or
`log_file_max_size_KB` if necessary.

## Launch on Boot (Asus Merlin)

cake-autorate can be launched on boot by adding an appropriate entry
to e.g. post-mount - see
[here](https://github.com/RMerl/asuswrt-merlin.ng/wiki/User-scripts).

For example, add these lines to /jffs/scripts/post-mount:

```bash
source /etc/profile
/jffs/scripts/cake-autorate/launcher.sh
```

## Preserving cake-autorate files for backup or upgrades (OpenWrt) (setup.sh installs only)

OpenWrt devices can save files across upgrades. Read the
[Backup and Restore page on the OpenWrt wiki](https://openwrt.org/docs/guide-user/troubleshooting/backup_restore#customize_and_verify)
for details.

To ensure the cake-autorate script and configuration files are
preserved, enter the files below to the OpenWrt router's
[Configuration tab](https://openwrt.org/docs/guide-user/troubleshooting/backup_restore#back_up)

```bash
/root/cake-autorate
/etc/init.d/cake-autorate
```

## Multi-WAN Setups

- cake-autorate has been designed to run multiple instances
  simultaneously.
- cake-autorate will run one instance per config file present in the
  _/root/cake-autorate/_ directory in the form:

```bash
config.instance.sh
```

where 'instance' is replaced with e.g. 'primary', 'secondary', etc.

With the **OpenWrt package**, add one `instance` section per WAN
instead (Instances page → *Add*, or a new `config instance '<id>'`
section in `/etc/config/cake-autorate`). Each instance runs as its own
procd instance and can be started and stopped separately. With mwan3,
set *Probe routing* (Instances page, *Pinger* tab) so that each
instance's pings leave through its own WAN.

## Selecting a pinger method

cake-autorate reads the `${pinger_method}` variable in the config file
to select the pinger method. Choices include:

| Pinger Method    | Delay Type | Target Mode            | Description                                                                  |
|------------------|------------|------------------------|------------------------------------------------------------------------------|
| **fping**        | RTT        | Round Robin            | Regular pinging to multiple reflectors with tightly controlled timings.      |
| **fping-ts**     | OWD        | Round Robin            | ICMP Type 13 pinging to multiple reflectors with tightly controlled timings. |
| **tsping**       | OWD        | Round Robin            | ICMP Type 13 pinging to multiple reflectors with tightly controlled timings. |
| **irtt**         | OWD        | Individual             | Custom UDP packet-based latency testing to a single reflector.               |
| **iputils-ping** | RTT        | Individual             | Advanced pinging with sub-1s frequency and more features than BusyBox ping.  |

Pinger methods with 'delay type' RTT (round trip time) can only determine
the sum total of the upload and download latency (A->B and B->A). The
OWD (one way delay) is then simply set as RTT/2. This has the drawback that
the directionality of the bufferbloat cannot be ascertained and so both
download and upload rates will be punished during detected latency increases.
In practice, despite this limitation, cake-autorate still performs very well
when working with RTTs. This is in part because connections are most often 
saturated in one direction rather than both directions. Also, these pinger 
methods use regular ICMPs, which are very reliable. 

By contrast, pinger methods with 'delay type' OWD (one way delay) facilitate
determinining the individual upload and download latencies. This has the 
benefit that the directionality of the bufferbloat can be ascertained and so
only the direction associated with bufferbloat is punished during detected
latency increases. A drawback of these pinger methods is the use of irregular
pinging techniques like ICMP type 13 (only IPV4, not all hosts will respond
to these, and local/remote clock issues) or irtt's custom UDP packet (requires
dedicated irtt server). 

**About fping-ts**: thanks to [@moeller0](https://github.com/moeller0)'s
request - see here: https://github.com/schweikert/fping/issues/265, 
fping introduced ICMP type 13 pinging with version 5.3.

**About tsping**: [@Lochnair](https://github.com/Lochnair) has coded up 
an elegant ping utility in C that sends out ICMP type 13 requests in a
round robin manner, thereby facilitating determination of one way delays
(OWDs), i.e. not just round trip time (RTT), but the constituent 
download and upload delays, relative to multiple reflectors. Presently
this must be compiled manually (although we can expect an official 
OpenWrt package soon).

Instructions for building a `tsping` OpenWrt package are available
[from github.](https://github.com/Lochnair/tsping)
