# Changelog

All notable changes to Print Better are documented here. Versions follow [Semantic Versioning](https://semver.org/). Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/); see [CONTRIBUTING.md](CONTRIBUTING.md#versions) for how they map to releases.

## [Unreleased]

### Added

- **remote printers:** the Mac print dialog offers what the printer on the other device has: paper trays (**Paper Feed**), paper types, the print qualities it supports, and two-sided printing when it can. Each choice reaches that printer as the matching job option.
- **remote printers:** **Supply Levels** in Printers & Scanners shows the printer's toner and ink, and its **Supplies** button opens the printer's page in the web app.
- **printers:** devices report each printer's trays (`capabilities.sources`), paper types (`mediaTypes`) and qualities (`qualities`); jobs accept `source` and `mediaType` options (REST, MCP and device jobs).

### Changed

- **remote printers:** a device's `pb_` queues are regenerated when the printer's options change, and once after this update so existing queues pick up the new options and supply levels.

### Fixed

- **doctor:** a device with every discovery method turned off shows Discovery as off instead of failing with "No printers found".

## [0.1.2] - 2026-11-19

### Added

- **updates:** Macs and Linux devices can install new client versions on their own (**Install updates automatically** in device settings), and the Devices page shows when an update is available, with an **Update now** button.
- **updates:** Linux machine-wide installs update unattended through a small root helper (`printbetter-update.path` and `printbetter-update.service`). Existing installs get it by re-running the install command or `sudo printbetter service install --system`.

### Fixed

- **remote printers:** a printer is no longer listed twice on a Mac or desktop that can already reach it directly: the server leaves out printers the device reports itself (matched by key or uuid), and the device hides remote copies of printers it sees on Bonjour. Away from that network the remote copy comes back.
- **remote printers:** a device no longer rediscovers its own `pb_` queues and reports them back to the server.
- **doctor:** devices without CUPS (headless Linux, Raspberry Pi) no longer fail the remote printers check; it is skipped there.
- **client:** the IPP server reads what a client already sent before refusing a request, so the client gets the error instead of a reset connection.

## [0.1.1] - 2026-11-19

### Added

- **remote printers:** printers on your other devices show up as normal printers on paired Macs and Linux desktops, in System Settings and in every app's print window. On by default; turn it off per device or with `printbetter config set remotePrinters off`. See [docs/remote-printers.md](docs/remote-printers.md).
- **client:** a loopback IPP server on `127.0.0.1:8632` that takes jobs from the system print queues and sends them to the server. If the server is unreachable, the print system holds the job and retries.
- **api:** device job endpoints (`/api/client/jobs`) so a client can queue jobs for printers on other devices, with the same checks as REST uploads.
- **jobs:** job lists show where a job came from, for example "From Office Mac (alex)". Migration `0003_device_jobs.sql` adds the `device` source and the new columns.
- **account:** email verification with send and resend, and a `/verify-email` page.
- **account:** connect Google or an OpenID Connect provider to an existing account under Your account > Sign-in and security > Connected accounts.

## [0.1.0] - 2026-11-18

First release.

### Added

- **server:** one Cloudflare Worker that serves the REST API, the web app, the MCP server, and the install scripts, with D1 for data, R2 for documents and client downloads, and one Durable Object per workspace for live device connections.
- **web app:** home, printers, print jobs, devices, members, workspace settings, and server admin. Light, dark, and system themes, accent colors, text size, and density.
- **accounts:** username and password, passkeys, Google and OpenID Connect sign-in, workspaces with owner, admin, and member roles, invite links, recovery codes, and password reset by email or admin link.
- **printing:** web upload, REST API, test pages, per-printer defaults, cancel and retry, and documents deleted after the workspace's retention time.
- **mcp:** a stateless MCP server for the 2026-07-28 and 2025 protocol versions, with a built-in OAuth 2.1 server and tools for everything the web app can do, including first-time setup.
- **email:** optional outbound mail through Resend or Cloudflare, and optional email to print through Cloudflare Email Routing or Resend inbound. Off by default.
- **client:** the `printbetter` daemon, CLI, and tray for macOS, Linux, and Windows. Discovery over Bonjour, SNMP, USB, and the system printer list; printing over IPP, IPPS, raw 9100, LPD, USB, CUPS, and the Windows spooler; PDF to raster conversion for PWG, Apple Raster, PCL, and PostScript printers.
- **client:** a local status page at `http://127.0.0.1:47631`, `printbetter doctor`, and optional LAN sharing that re-advertises printers for AirPrint and IPP Everywhere (off by default).
- **install:** one-line install scripts for macOS, Linux, and Windows, a signed and notarized macOS installer, and Raspberry Pi first-boot files written in the browser.
- **release:** `scripts/release.sh` cross-builds every target from a Mac, signs and notarizes the macOS app, and publishes downloads to R2. `scripts/deploy.sh` deploys the server and creates its secrets.
