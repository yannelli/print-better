# Client CLI and install contract

One binary, `printbetter`. Used by people, install scripts, the web UI's copy-paste commands, and Raspberry Pi first boot.

## Commands
```
printbetter run [--no-tray]                     start the daemon (+ tray on desktops unless disabled)
printbetter pair --server URL --token pbe_… [--name NAME]   enroll with a token
printbetter pair --server URL [--name NAME]     device-code flow: prints a code, opens the browser
printbetter unpair                              forget credentials (asks unless --yes)
printbetter status [--json]                     connection, client name, printers, queue
printbetter printers [--json]                   printers known to the daemon
printbetter discover [--json] [--timeout SECS]  one-shot local discovery, no server needed
printbetter print FILE [--printer KEY|NAME] [--copies N] [--media NAME] [--sides one|long|short] [--color|--mono]
printbetter tray on|off                         persisted; restarts the tray if running
printbetter pause | resume                      hold or release printing on this device
printbetter config get [KEY] | set KEY VALUE    local settings (dotted keys, e.g. discovery.snmp)
printbetter service install [--system] [--no-tray] | uninstall [--system] | start | stop | restart | status
printbetter logs [--follow] [--lines N]
printbetter doctor [--json]                     same checks as the `diagnose` command
printbetter update [--check] [--yes]            install the newest release from the paired server
printbetter version | help
```
- Exit codes: 0 ok, 1 error, 2 usage, 3 not paired, 4 daemon not running (for commands that need it).
- A non-GUI `run` that finds another copy on port 47631 exits 1, so launchd/systemd keep retrying after an upgrade race; double-click launches exit 0 and open the status page instead.
- First run: when a tray session finds the daemon unpaired it opens `http://127.0.0.1:47631/` once (remembered per user), which is where double-click installs connect to a server.
- Commands that need the daemon talk to it at `http://127.0.0.1:47631`; `print` and `discover` fall back to running in-process when the daemon is down.
- Env: `PRINTBETTER_HOME` overrides config/state paths; `PRINTBETTER_PORT` overrides the local API port (default 47631) for the daemon, CLI, tray, and status page; `PRINTBETTER_REMOTE_PORT` overrides the remote printers loopback port (default 8632); `PRINTBETTER_LOG=debug`.

## Remote printers
On macOS and Linux, added printers on other devices in the workspace appear as system print queues named `pb_<printerId>`, so every app's print dialog can use them (details: `remote-printers.md`). On by default; `printbetter config set remotePrinters off` removes the queues and syncs the setting to the server like any other. Creating queues needs CUPS admin rights (`lpadmin`: root, or an admin/`lpadmin` group user); problems show on the status page, in the tray, and in `printbetter doctor`. Not available on Windows yet.

## Updates
macOS and Linux devices update themselves from the server they are paired with (`GET /api/client/latest`): first check about 2 minutes after start, then every 6 hours (with jitter), and on request (`printbetter update`, the tray's "Update to x.y.z", the status page, or "Update now" in the dashboard). With `autoUpdate` off (`printbetter config set autoUpdate off`, or the device settings in the web UI) checks still run but only requested updates install; development builds (a binary under a Cargo `target` folder) also install only on request. Newer versions only, never a downgrade.
- The download comes only from the paired origin, with the device token, and must match the manifest's size and SHA-256. Automatic installs wait up to 30 minutes for running jobs to finish.
- Linux: the tarball's binary is checked (`printbetter version` must report the new version), written next to the running one, and renamed over it; the daemon then shuts down cleanly and re-executes itself with the same arguments (same PID under systemd).
- macOS system install (root LaunchDaemon, `/Applications/Print Better.app`): the pkg must pass `pkgutil --check-signature` with a Developer ID Installer certificate from the running app's own team; `installer -pkg … -target /` runs it and its postinstall reloads the service.
- macOS per-user install: the zip is unpacked next to the app, must pass `codesign --verify --deep --strict` with the same team ID, and is swapped in atomically before a restart.
- Any failure leaves the current install untouched and shows on the status page, in `printbetter status`, and in `printbetter doctor`. Windows does not update itself yet; re-run the install command.
- Linux machine-wide service: the daemon runs as `printbetter` and can't write `/usr/local/bin/printbetter`, so it only creates `/var/lib/printbetter/update-request` (its own state folder). `printbetter-update.path` then starts `printbetter-update.service` as root (`printbetter update-helper`), which fetches the release itself with the device credentials, verifies size and SHA-256, swaps the binary, records the outcome in `/var/lib/printbetter-update/result.json` (the daemon reads it for status), and runs `systemctl try-restart printbetter.service`. `sudo printbetter update` runs the same routine.
- Existing Linux system installs get the helper once 0.1.2 or later is installed and `sudo printbetter service install --system` runs (re-running the install one-liner does this). Until then `printbetter doctor` reports that updates need it.

## Service install
| OS | user mode (default) | `--system` |
|---|---|---|
| macOS | LaunchAgent `~/Library/LaunchAgents/dev.yannelli.printbetter.plist` (RunAtLoad, KeepAlive on crash) running `<binary> run` | LaunchDaemon, implies `--no-tray` |
| Linux | `systemd --user` unit `printbetter.service` (hint `loginctl enable-linger` for headless) | `/etc/systemd/system/printbetter.service`, system user `printbetter` in group `lp`, udev rule `/etc/udev/rules.d/60-printbetter.rules` for USB printer-class access, root update helper `printbetter-update.service` + `printbetter-update.path` (see Updates), implies `--no-tray` |
| Windows | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\PrintBetter` → `"<exe>" run` | scheduled task at startup as SYSTEM, implies `--no-tray` |

The Windows exe uses the GUI subsystem and attaches to the parent console for CLI output, so login autostart never flashes a console window.

macOS system mode (what the signed pkg runs) installs a root LaunchDaemon (`run --no-tray`, config under `/Library/Application Support/Print Better/`) plus an all-users tray agent (`tray-ui`) that talks to it over the local API, so no Local Network prompt ever appears. System installs remove a conflicting per-user install and carry its pairing over; a user-mode install on a machine that already has the system daemon exits 0 without changes.

## Install scripts (served by the Worker)
- Unix: `curl -fsSL <origin>/install.sh | sh -s -- --token pbe_… [--name NAME] [--system] [--no-tray] [--version V]`
- Windows: `$env:PB_TOKEN='pbe_…'; irm <origin>/install.ps1 | iex` (also reads `PB_NAME`, `PB_VERSION`)
- Steps: detect OS/arch → read `<origin>/dl/latest.json` → download → verify SHA-256 → install → `pair` → `service install` → start. Re-running upgrades in place and keeps the pairing.
- Locations: macOS `~/Applications/Print Better.app` (CLI symlink `~/.local/bin/printbetter`); Linux root `/usr/local/bin/printbetter`, non-root `~/.local/bin/printbetter`; Windows `%LOCALAPPDATA%\Print Better\printbetter.exe`.
- Linux as root, or with no graphical session, defaults to `--system --no-tray`.

## Downloads manifest
R2 key `downloads/latest.json`, served at `/dl/latest.json`; files under `downloads/<version>/`, served at `/dl/<version>/<name>`.
```json
{
  "version": "0.1.0",
  "files": {
    "macos-universal": { "name": "printbetter-0.1.0-macos-universal.zip", "sha256": "…", "size": 0 },
    "macos-pkg": { "name": "PrintBetter-0.1.0.pkg", "sha256": "…", "size": 0 },
    "linux-x86_64": { "name": "printbetter-0.1.0-linux-x86_64.tar.gz", "sha256": "…", "size": 0 },
    "linux-aarch64": { "name": "printbetter-0.1.0-linux-aarch64.tar.gz", "sha256": "…", "size": 0 },
    "linux-armv7": { "name": "printbetter-0.1.0-linux-armv7.tar.gz", "sha256": "…", "size": 0 },
    "linux-armv6": { "name": "printbetter-0.1.0-linux-armv6.tar.gz", "sha256": "…", "size": 0 },
    "windows-x86_64": { "name": "printbetter-0.1.0-windows-x86_64.exe", "sha256": "…", "size": 0 },
    "windows-aarch64": { "name": "printbetter-0.1.0-windows-aarch64.exe", "sha256": "…", "size": 0 }
  }
}
```
- The macOS zip holds `Print Better.app` (binary at `Contents/MacOS/printbetter`); Linux tarballs hold the single `printbetter` binary.
- Missing platforms are simply absent; scripts fail with a clear message.

## Raspberry Pi first boot
The web UI generates cloud-init files in the browser (Wi-Fi credentials never reach the server). `runcmd` waits for network, then runs the Unix install one-liner with `--system --no-tray --name <hostname>`.
