# Changelog

All notable changes to Print Better are documented here. Versions follow [Semantic Versioning](https://semver.org/). Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/); see [CONTRIBUTING.md](CONTRIBUTING.md#versions) for how they map to releases.

## [Unreleased]

### Added

- **iPhone:** Print Better for iPhone and iPad (iOS 26 or later). It pairs with the server address and a sign-in in Safari, or with the QR code under **Devices > Add a device**; lists printers with their status, location and supplies; prints files, photos and document scans with the printer's own options; follows and cancels jobs; prints from other apps through the share sheet, where Safari pages print as WebKit lays them out; and adds a **Print with Print Better** action to Shortcuts. Building, signing and releasing: `docs/ios.md`.
- **devices:** `GET /api/client/me`, `GET /api/client/printers` and `GET /api/client/jobs` give devices without a WebSocket the name, printers and jobs a computer learns over it. The printer list follows printer access.
- **web:** **Add a device** has an iPhone choice with a pairing QR code. Device pages show an iPhone's last use instead of Offline, and leave out the printer and sharing sections it has no use for.

### Changed

- **devices:** `GET /api/client/latest` answers 404 `no_build` to iPhones, which update through the App Store.

## [0.1.4] - 2026-11-19

### Added

- **extensions:** optional modules that stay off until a server admin makes one available under **Admin > Extensions** and a workspace owner turns it on under **Workspace settings > Extensions**. Turning one off restores the default rules and keeps its data. New routes `/api/admin/extensions` and `/api/workspaces/:ws/extensions`, audited as `extension.update`, and an `access` event that tells open pages to refresh.
- **printer access:** an extension that decides who can see, print to, and manage each printer, with built-in roles (Viewer, User, Manager) and custom ones, groups of members and devices, a per-printer Everyone setting, and grants on one printer or on all of them. It applies in the web app, the REST API, MCP (14 new tools), email to print, and the printers a computer's print window offers. Turning it on changes nothing by itself (docs/printer-access.md).
- **printer access:** `GET /api/workspaces/:ws/access/me` reports what the caller may do on each printer, also while printer access is off.
- **remote printers:** a job that a computer may not send fails in its print queue with "You can't print to this printer from this computer".

### Changed

- **brand:** a new mark (a page leaving a printer) for the macOS app icon, the web app icons, and the favicon, which follows the system dark mode. The README opens with a hero banner, and `docs/assets/social-preview.png` is ready for the repository's social preview. `scripts/make-brand.sh` renders both from HTML.

### Fixed

- **web:** a computer's default printer that the server knows only by its queue name shows a readable name instead of the raw queue name.

## [0.1.3] - 2026-11-19

### Added

- **remote printers:** the Mac print dialog offers what the printer on the other device has: paper trays (**Paper Feed**), paper types, the print qualities it supports, and two-sided printing when it can. Each choice reaches that printer as the matching job option.
- **remote printers:** **Supply Levels** in Printers & Scanners shows the printer's toner and ink, and its **Supplies** button opens the printer's page in the web app.
- **printers:** devices report each printer's trays (`capabilities.sources`), paper types (`mediaTypes`) and qualities (`qualities`); jobs accept `source` and `mediaType` options (REST, MCP and device jobs).
- **remote printers:** a Mac or Linux desktop's page in the web app has a **Printers on this computer** section: show or hide each printer from your other devices on that computer, see how each one is set up there (added as a system printer, hidden, or waiting, and whether it is also installed directly), and pick that computer's **Default printer**. A default changed on the computer itself wins, and on Macs set to **Last Printer Used** the page says how to make the choice stick. New device settings `remotePrintersHidden` and `defaultPrinter`, also in `printbetter config`. Devices need this version to report their printers.

### Changed

- **remote printers:** a computer's **Printers on this computer** section names printers the way its print window does ("In the print window as “Upstairs laser”", "Right now it's HP LaserJet M404 (Print Better)") instead of by CUPS queue; the `pb_` queue id is a small detail under each printer. Devices report the descriptions of directly installed queues and of the default printer (`installedName`, `defaultName`).
- **remote printers:** a printer a Mac or desktop also finds on its own network keeps its Print Better queue. Neither the device (Bonjour) nor the server (the device's own inventory) leaves it out anymore; the web app shows when it is also installed directly, and hiding it there is the user's call.
- **remote printers:** a device's `pb_` queues are regenerated when the printer's options change, and once after this update so existing queues pick up the new options and supply levels.

### Fixed

- **remote printers:** a `pb_` queue that already exists and points at the device's own loopback server (a lost record, or one recreated by hand) is taken over and regenerated once instead of failing with "already exists".
- **printers:** a printer that another device has already added no longer shows up again under **Found but not added** when a second device finds it (matched by printer uuid).
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
