# Changelog

Versions follow [Semantic Versioning](https://semver.org/). Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), and [CONTRIBUTING.md](CONTRIBUTING.md#versions) shows how they map to releases.

## [Unreleased]

## [0.1.6] - 2026-11-19

### Added

- **print rules and limits:** Adds the Print rules and limits extension, which checks every job before it's queued: from the web app, the API, MCP, email to print, test pages, and a computer's print window. Rules match who sent a job, where from, the printer, pages, copies, color, sides, file type, size, and time, then refuse it, print it two-sided or in black and white, limit copies, send it to another printer, or add a note. Turning it on changes nothing by itself (docs/print-policies.md).
- **print rules and limits:** Adds limits on pages, sheets, jobs, or cost for each member, 1 member, a group (shared or each), each device, 1 device, a printer, or the workspace, every day, week, month, quarter, or year in the workspace time zone. A job that would go over is refused with what's left and when the count starts over, or prints with a warning. Admins can give extra for the current cycle.
- **print rules and limits:** Adds the **Usage** page (Overview for everyone, Limits and Rules for owners and admins), a card on Home with the limit closest to running out, the routes under `/api/workspaces/:ws/policies`, `/usage/me` and `/usage`, and 12 MCP tools.
- **usage:** Counts the pages of PDFs, images, and text on the server and in the browser, records each attempt's pages, sheets, and cost, and settles them with the pages the printer reports when the job ends. It runs only while Print rules and limits or Enterprise controls is on. With both off, jobs and their responses stay exactly as they were (docs/usage.md).
- **usage:** Adds prices for black-and-white and color pages with a two-sided discount, per printer if needed, and the workspace currency and time zone, under **Workspace settings > Prices**, `GET` and `PUT /api/workspaces/:ws/prices`, and the MCP tools `get_prices` and `set_prices`.
- **usage:** Adds `POST /api/workspaces/:ws/jobs/preview` and the `preview_print_job` tool. The print dialog uses it to show what will happen to a job, and what it leaves you, before you send it.
- **remote printers:** Shows a rule's or limit's refusal in the computer's print queue, like a printer access refusal.
- **extensions:** Adds the **Enterprise controls** extension, off by default, with a switch for each part: approvals, secure release, cost centers and budgets, reports, alerts, and retention and privacy. Jobs can wait for an approver or for their sender to release them at the printer, from **Print jobs > Approvals** and **Print jobs > Ready to release**, which work on a phone. A held job from a computer's print window ends in its print queue with "Waiting for approval" or "Waiting to be released at the printer", so the jobs behind it still print. Jobs are charged to a cost center picked in the print dialog or by default, and budgets per cycle can block, warn, or require approval. Admins get usage reports with CSV export, weekly or monthly report emails, and an audit log export under **Usage**. Alerts email at 80% and 100% of limits and budgets. Owners can delete documents as soon as jobs finish and hide document names. The REST API and 18 MCP tools cover all of it. See [Enterprise Controls](docs/enterprise.md).
- **web:** Adds **Show more** to the **Activity** tab, which loads older changes 50 at a time. It used to stop at the latest 50.
- **scripts:** Adds `scripts/restore-d1.sh`, which loads a `wrangler d1 export` file into an empty database. Exports can't be loaded as they are, because each table's rows come before the tables they reference.

### Fixed

- **linux:** Adds the machine-wide service user to the `lpadmin` group where the system has one (Debian, Ubuntu, Raspberry Pi OS), so it can create its print queues for other devices' printers. Existing installs join it at their next update.
- **deploy:** Saves the `APP_SECRET` and `AUTH_PEPPER` that `scripts/deploy.sh` creates to `~/.config/print-better/secrets.env` (readable only by you), since Cloudflare never shows a secret again.
- **extensions:** Names the **Server admin > Extensions** screen correctly in the messages for an extension that is off or unavailable.

## [0.1.5] - 2026-11-19

### Added

- **docs:** Adds a docs site that every server serves at `/docs`, public with no sign-in. It has 36 pages covering setup, devices, printers, printing, workspaces, extensions, and reference, with search, an "On this page" list, and copy buttons on code. Code examples show the reader's own server address. The app links to it from the sidebar, the command menu, and the sign-in screens.
- **web:** Adds the links `/printers`, `/jobs`, `/devices`, `/devices/add`, `/members`, and `/settings/<tab>`, which open that screen in your current workspace, so docs and bookmarks can point to them.

### Changed

- **web:** Splits workspace settings into tabs (General, Printing, Email to print, Extensions, Activity, and a tab for each turned-on extension that has settings), each at its own address. An extension adds a tab instead of more sections on 1 page.

### Fixed

- **printing:** Flags a job the printer only partly printed instead of showing it as a clean success. The client counts the pages it sends (PDFs, images, and the text it lays out) and compares them with what a network printer reports, so a short print finishes as completed with a warning: "The printer stopped after 4 of 11 pages. It didn't report an error." Jobs sent through a CUPS queue skip the comparison, since CUPS counts pages with its own filters.
- **printing:** Turns reasons such as `job-completed-with-errors` or `document-format-error` on a completed job into a warning in plain words. A job the client lost track of, or stopped checking after 2 hours, says so instead of claiming it printed.
- **printing:** Names the document error when a printer aborts a job for one ("The printer couldn't read the document.") instead of showing a general message.
- **printing:** Finishes a job cleanly, without a lost-track warning, when the printer drops it from its history after every page was counted.
- **web:** Shows a completed job with a warning as "Printed with a problem" in amber, with the message, in print jobs, recent jobs, and the print window. MCP job text, `printbetter print`, and the client's status page show the warning too.
- **remote printers:** Finishes a job that ended with a warning in the computer's print queue as completed, with `job-completed-with-warnings` and the message.
- **web:** Keeps proper names in job origins, for example "From the API" and "From an AI assistant".
- **web:** Limits the largest-file setting to 1 to 100 MB, which is what the server allows.

## [0.1.4] - 2026-11-19

### Added

- **extensions:** Adds extensions, optional modules that stay off until a server admin makes one available under **Server admin > Extensions** and a workspace owner turns it on under **Workspace settings > Extensions**. Turning one off restores the default rules and keeps its data. Adds the routes `/api/admin/extensions` and `/api/workspaces/:ws/extensions` (audited as `extension.update`) and an `access` event that tells open pages to refresh.
- **printer access:** Adds the printer access extension, which decides who can see, print to, and manage each printer. It has built-in roles (Viewer, User, Manager) and custom ones, groups of members and devices, a per-printer Everyone setting, and grants on 1 printer or on all of them. It applies in the web app, the REST API, MCP (14 new tools), email to print, and the printers a computer's print window offers. Turning it on changes nothing by itself (docs/printer-access.md).
- **printer access:** Adds `GET /api/workspaces/:ws/access/me`, which reports what the caller may do on each printer, also while printer access is off.
- **remote printers:** Adds a print queue error for jobs a computer may not send: "You can't print to this printer from this computer".

### Changed

- **brand:** Uses a new mark (a page leaving a printer) for the macOS app icon, the web app icons, and the favicon, which follows the system dark mode. The README opens with a hero banner, and `docs/assets/social-preview.png` is ready for the repository's social preview. `scripts/make-brand.sh` renders both from HTML.

### Fixed

- **web:** Shows a readable name instead of the raw queue name for a computer's default printer that the server knows only by its queue name.

## [0.1.3] - 2026-11-19

### Added

- **remote printers:** Adds the remote printer's own options to the Mac print dialog: paper trays (**Paper Feed**), paper types, the print qualities it supports, and two-sided printing when it can. Each choice reaches that printer as the matching job option.
- **remote printers:** Adds the printer's toner and ink to **Supply Levels** in Printers & Scanners. Its **Supplies** button opens the printer's page in the web app.
- **printers:** Adds each printer's trays (`capabilities.sources`), paper types (`mediaTypes`), and qualities (`qualities`) to device reports. Adds the `source` and `mediaType` job options (REST, MCP, and device jobs).
- **remote printers:** Adds a **Printers on this computer** section to a Mac or Linux desktop's page in the web app. It shows or hides each printer from your other devices on that computer, shows how each one is set up there (added as a system printer, hidden, or waiting, and whether it's also installed directly), and picks that computer's **Default printer**. A default changed on the computer itself wins. On Macs set to **Last Printer Used**, the page says how to make the choice stick. Adds the device settings `remotePrintersHidden` and `defaultPrinter`, also in `printbetter config`. Devices need this version to report their printers.

### Changed

- **remote printers:** Names printers in a computer's **Printers on this computer** section the way its print window does ("In the print window as “Upstairs laser”", "Right now it's HP LaserJet M404 (Print Better)") instead of by CUPS queue. The `pb_` queue id is a small detail under each printer. Devices report the descriptions of directly installed queues and of the default printer (`installedName`, `defaultName`).
- **remote printers:** Keeps the Print Better queue for a printer that a Mac or desktop also finds on its own network. Neither the device (Bonjour) nor the server (the device's own inventory) leaves it out anymore. The web app shows when it's also installed directly, and hiding it there is the user's call.
- **remote printers:** Regenerates a device's `pb_` queues when the printer's options change, and once after this update so existing queues pick up the new options and supply levels.

### Fixed

- **remote printers:** Fixes "already exists" failures: A `pb_` queue that already exists and points at the device's own loopback server (a lost record, or one recreated by hand) is taken over and regenerated once.
- **printers:** Stops a printer that another device already added from showing up again under **Found but not added** when a second device finds it (matched by printer uuid).
- **doctor:** Shows Discovery as off on a device with every discovery method turned off, instead of failing with "No printers found".

## [0.1.2] - 2026-11-19

### Added

- **updates:** Adds automatic client updates on Macs and Linux devices (**Install updates automatically** in device settings). The Devices page shows when an update is available, with an **Update now** button.
- **updates:** Adds a small root helper (`printbetter-update.path` and `printbetter-update.service`) so Linux machine-wide installs update unattended. Existing installs get it by re-running the install command or `sudo printbetter service install --system`.

### Fixed

- **remote printers:** Stops listing a printer twice on a Mac or desktop that can already reach it directly. The server leaves out printers the device reports itself (matched by key or uuid), and the device hides remote copies of printers it sees on Bonjour. Away from that network, the remote copy comes back.
- **remote printers:** Stops a device from rediscovering its own `pb_` queues and reporting them back to the server.
- **doctor:** Skips the remote printers check on devices without CUPS (headless Linux, Raspberry Pi), where it used to fail.
- **client:** Fixes a reset connection when the IPP server refuses a request. The server reads what the client already sent first, so the client gets the error.

## [0.1.1] - 2026-11-19

### Added

- **remote printers:** Adds remote printers. Printers on your other devices show up as normal printers on paired Macs and Linux desktops, in System Settings and in every app's print window. On by default. Turn it off per device or with `printbetter config set remotePrinters off`. See [docs/remote-printers.md](docs/remote-printers.md).
- **client:** Adds a loopback IPP server on `127.0.0.1:8632` that takes jobs from the system print queues and sends them to the server. If the server is unreachable, the print system holds the job and retries.
- **api:** Adds device job endpoints (`/api/client/jobs`) so a client can queue jobs for printers on other devices, with the same checks as REST uploads.
- **jobs:** Adds each job's source to job lists, for example "From Office Mac (alex)". Migration `0003_device_jobs.sql` adds the `device` source and the new columns.
- **account:** Adds email verification with send and resend, and a `/verify-email` page.
- **account:** Lets people connect Google or an OpenID Connect provider to an existing account under **Your account > Sign-in and security > Connected accounts**.

## [0.1.0] - 2026-11-18

### Added

- **server:** Adds 1 Cloudflare Worker that serves the REST API, the web app, the MCP server, and the install scripts, with D1 for data, R2 for documents and client downloads, and 1 Durable Object per workspace for live device connections.
- **web app:** Adds the home, printers, print jobs, devices, members, workspace settings, and server admin pages. Adds light, dark, and system themes, accent colors, text size, and density.
- **accounts:** Adds username and password, passkeys, Google and OpenID Connect sign-in, workspaces with owner, admin, and member roles, invite links, recovery codes, and password reset by email or admin link.
- **printing:** Adds web upload, the REST API, test pages, per-printer defaults, and cancel and retry. Documents are deleted after the workspace's retention time.
- **mcp:** Adds a stateless MCP server for the 2026-07-28 and 2025 protocol versions, with a built-in OAuth 2.1 server and tools for everything the web app can do, including first-time setup.
- **email:** Adds optional outbound mail through Resend or Cloudflare, and optional email to print through Cloudflare Email Routing or Resend inbound. Off by default.
- **client:** Adds the `printbetter` daemon, CLI, and tray for macOS, Linux, and Windows. It discovers printers over Bonjour, SNMP, USB, and the system printer list, prints over IPP, IPPS, raw 9100, LPD, USB, CUPS, and the Windows spooler, and converts PDF to raster for PWG, Apple Raster, PCL, and PostScript printers.
- **client:** Adds a local status page at `http://127.0.0.1:47631`, `printbetter doctor`, and optional LAN sharing that re-advertises printers for AirPrint and IPP Everywhere (off by default).
- **install:** Adds one-line install scripts for macOS, Linux, and Windows, a signed and notarized macOS installer, and Raspberry Pi first-boot files written in the browser.
- **release:** Adds `scripts/release.sh`, which cross-builds every target from a Mac, signs and notarizes the macOS app, and publishes downloads to R2. Adds `scripts/deploy.sh`, which deploys the server and creates its secrets.
