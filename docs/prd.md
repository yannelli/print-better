# Print Better: Product Requirements

| | |
|---|---|
| **Status** | Phase 1 shipped (0.1.x). Phase 2 in planning. |
| **Owner** | Maintainer (see [README](../README.md#maintainer)) |
| **Related** | [Architecture](architecture.md), [Remote printers](remote-printers.md), [Client protocol](protocol.md), [MCP server](mcp.md) |

## 1. Summary

Print Better makes printing reliable and easy for people who should never have to think about it. It has two parts: a self-hosted **print server** that runs on the owner's Cloudflare account, and a small **client** (`printbetter`) that runs on any computer next to a printer. Anyone in a workspace can print to any of its printers from the web, from any app's print window, from scripts, or through an AI assistant, whether they are at home or away.

## 2. Problem

Printing is one of the least reliable parts of everyday computing:

- **Setup is fragile.** Drivers, ports, and vendor apps fail in ways newcomers and older users cannot diagnose. The family "IT person" ends up fixing the same printer over and over.
- **Printers are tied to one network.** AirPrint and IPP Everywhere only work on the local network. Printing from work, a phone on cellular, or a laptop at a café usually means a cloud service tied to one vendor.
- **Jobs get lost.** When a computer sleeps, a printer is offline, or Wi-Fi drops, jobs disappear or hang without a clear reason.
- **Discovery is slow and duplicated.** Print dialogs list the same printer more than once, or take a long time to find it.
- **Nothing is scriptable or assistant-friendly.** There is no simple, permissioned API to print, check toner, or set up a new printer from code or an AI assistant.

## 3. Goals and non-goals

### Goals

1. **Minimal clicks.** Someone who has never set up a printer can go from nothing to a printed page with one command or one installer, plus one approval in the browser.
2. **Reliable by default.** A submitted job prints or fails with a reason a person can understand. It never silently disappears.
3. **Works with the printers people already own.** Driverless IPP, raw sockets, LPD, USB, and the operating system's print system, with conversion for printers that cannot read PDF.
4. **Native everywhere.** Printers on other devices appear as ordinary printers in macOS and Linux print dialogs, with no duplicates.
5. **Customizable anywhere.** Every automatic behavior (discovery, auto-add, defaults, sharing, updates) can be changed per workspace, per device, or per printer.
6. **Fully operable by AI assistants.** Everything the web app can do is available over MCP, with the same permissions.
7. **Self-hosted and small.** One Worker deployment on the owner's account, few dependencies, and no third-party print cloud.

### Non-goals (phase 1)

- Replacing CUPS or the Windows spooler as the local print system.
- Vendor-specific driver features (custom finishing units, proprietary color profiles).
- Billing, quotas, or print accounting for large organizations.
- A hosted multi-tenant service run by the project.
- A public IPP endpoint on the server (printing to the server directly from any OS).

## 4. Users

| Persona | Needs | What success looks like |
|---|---|---|
| **The helper** (family or office "IT person") | Set up printers once for others; fix things remotely | Adds a device in minutes and sees problems from anywhere |
| **The everyday printer** (older adults, newcomers) | Press Print and get paper | Never sees a setting; the printer is already in the print dialog |
| **The tinkerer** (homelab, Raspberry Pi, Proxmox) | Headless installs, CLI, API, logs | Script-only setup and clear diagnostics (`printbetter doctor`) |
| **The small office admin** | Several printers, members, roles, audit trail | Invite links, roles, per-printer defaults, and history |
| **The AI assistant** (Claude, ChatGPT, Claude Code) | A safe, complete tool surface | Can complete the whole setup and print on a user's behalf, within that user's permissions |

## 5. Principles

- **Plain language.** Errors say what happened and what to do ("Tray 2 is out of paper"), never just a status code.
- **Safe defaults, everything adjustable.** Smart defaults first, with an override at every level.
- **Outbound only.** Clients dial out to the server; nothing on the printer's network is exposed.
- **One source of truth.** The server database owns state; clients and browsers sync to it.
- **Few dependencies.** Small protocol pieces (IPP, MCP, OAuth, WebAuthn, OIDC, raster encoders) are written in-house when that avoids real bloat.
- **Small files, clear code.** Files stay under 300 lines; comments explain why.

## 6. Scope and requirements

Status key: **Shipped** (in 0.1.x), **Next** (0.1.3), **Later** (phase 2).

### 6.1 Server

| ID | Requirement | Status |
|---|---|---|
| S-1 | One Cloudflare Worker serves the REST API, web app, MCP server, OAuth endpoints, and install scripts | Shipped |
| S-2 | D1 stores state; R2 stores documents and client downloads; one Durable Object per workspace holds live device and browser connections | Shipped |
| S-3 | Documents are deleted after a workspace retention time (default 24 h) | Shipped |
| S-4 | A scheduled task cleans up expired sessions and tokens, fails abandoned uploads and stuck jobs, and marks silent devices offline | Shipped |
| S-5 | Deployable by one script that also creates the secrets it needs | Shipped |
| S-6 | A container build (workerd or Docker) for hosts other than Cloudflare | Later |

### 6.2 Accounts and access

| ID | Requirement | Status |
|---|---|---|
| A-1 | Username and password (scrypt, peppered), passkeys, recovery codes | Shipped |
| A-2 | Optional sign-in with Google or any OpenID Connect provider, and connecting one to an existing account | Shipped |
| A-3 | Workspaces with owner, admin, and member roles; invite links; invite-only signup by default | Shipped |
| A-4 | Email verification with resend; password reset by email or admin link | Shipped |
| A-5 | Personal API tokens with `read`, `write`, `print` scopes; an audit log of every change | Shipped |
| A-6 | Extensions: optional modules that stay off until a server admin makes one available and a workspace owner turns it on; turning one off restores the default rules and keeps its data | Next |
| A-7 | Printer access extension: who can see, print to, and manage each printer, with built-in and custom roles, groups of members and devices, and device rules, applied the same way in the web app, API, MCP, email, and print windows | Next |

### 6.3 Devices and setup

| ID | Requirement | Status |
|---|---|---|
| D-1 | One Rust binary for macOS, Linux (x86_64, aarch64, armv7), and Windows | Shipped |
| D-2 | Pairing by one-line install script, by device code from a double-clicked installer, or by a link from the web app | Shipped |
| D-3 | Raspberry Pi first-boot files generated in the browser; the Pi installs and pairs on first start | Shipped |
| D-4 | Signed, notarized, stapled macOS app and installer with a menu bar icon | Shipped |
| D-5 | Local status page, `printbetter doctor`, and remote diagnostics (logs, restart, identify) from the web app | Shipped |
| D-6 | Automatic updates, verified by size, SHA-256, and (on macOS) the signing team | Shipped |
| D-7 | Unattended updates for the sandboxed Linux system service through a small root helper | Next |
| D-8 | Microcontroller bridge firmware (ESP32 class) that connects a USB or network printer; the protocol already avoids assuming a full OS | Later |
| D-9 | Signed Windows builds | Later |

### 6.4 Discovery and printers

| ID | Requirement | Status |
|---|---|---|
| P-1 | Discovery over Bonjour, SNMP, USB, and the operating system's printer list, merged into one entry per physical printer | Shipped |
| P-2 | Auto-add policy per workspace, overridable per device: `smart` (default), `all`, `none` | Shipped |
| P-3 | Printer health every 60 s: state, reasons (out of paper, toner low), supply levels | Shipped |
| P-4 | Per-printer name, location, and default job options | Shipped |

### 6.5 Printing and jobs

| ID | Requirement | Status |
|---|---|---|
| J-1 | Print from web upload, REST API, MCP, a device's print dialog, and optional email | Shipped |
| J-2 | At-least-once delivery: jobs persist on the server and client, survive restarts, and dedupe by id | Shipped |
| J-3 | Transient failures retry with backoff (5 s up to 5 min) and try other routes; jobs time out after a workspace limit (default 24 h) | Shipped |
| J-4 | PDF passthrough when the printer accepts it; otherwise rasterize to PWG, Apple raster, PCL, or PostScript | Shipped |
| J-5 | Options: copies, media, sides, color mode, orientation, page ranges, fit, quality | Shipped |
| J-6 | Cancel and retry from any surface; history shows where each job came from | Shipped |

### 6.6 Remote printers (native print dialogs)

| ID | Requirement | Status |
|---|---|---|
| R-1 | On macOS and Linux, every added printer on other devices appears as a system printer, usable from any app | Shipped |
| R-2 | A printer the computer already reaches directly is never listed twice | Shipped |
| R-3 | Jobs printed while away from home are held and delivered when the printer's device is back | Shipped |
| R-4 | Supply levels, trays, and every option the real printer supports appear in the print dialog | Next |
| R-5 | From the web app, choose which printers appear on each computer and set its default printer | Next |
| R-6 | Remote printers on Windows | Later |

### 6.7 Sharing and email

| ID | Requirement | Status |
|---|---|---|
| L-1 | Optional LAN sharing: a device re-advertises its printers for AirPrint and IPP Everywhere (off by default) | Shipped |
| E-1 | Optional email to print through Cloudflare Email Routing or Resend, with an allowlist and DMARC checks (off by default) | Shipped |
| E-2 | Optional outbound email for invites, resets, and alerts | Shipped |

### 6.8 MCP and API

| ID | Requirement | Status |
|---|---|---|
| M-1 | Stateless streamable-HTTP MCP server for the 2026-07-28 protocol and the 2025 `initialize` era | Shipped |
| M-2 | Built-in OAuth 2.1 server (metadata discovery, client ID metadata documents and dynamic registration, PKCE, rotating refresh tokens) for assistant connectors | Shipped |
| M-3 | Tools cover everything the web app can do, including first-time setup, with the same permission checks as REST | Shipped |
| M-4 | Documented REST API for every web app action | Shipped |

### 6.9 Web app

| ID | Requirement | Status |
|---|---|---|
| W-1 | React and shadcn single-page app: home, printers, jobs, devices, members, settings, admin | Shipped |
| W-2 | Visual design: crisp, dense, monochrome precision mixed with warm tonal surfaces and rounded, springy motion | Shipped |
| W-3 | Light, dark, and system themes; accent color, text size, and density settings | Shipped |
| W-4 | Live updates over WebSocket; no manual refresh | Shipped |

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Reliability | No silent job loss. Every terminal state carries a human-readable reason. |
| Latency | With the printer's device online, a job starts printing within 3 s of submission (excluding upload time). |
| Security | Bearer secrets of at least 160 bits, stored hashed; scoped tokens; origin checks on cookie requests; instance secrets encrypted at rest; clients can only see their own workspace and printers. |
| Privacy | Documents are deleted after the retention time. No telemetry. Nothing leaves the owner's Cloudflare account except job delivery to the owner's devices. |
| Footprint | Client is one static binary. Idle CPU near zero; memory under 50 MB on a Raspberry Pi. |
| Compatibility | macOS 13+, mainstream Linux distributions (glibc and musl), Raspberry Pi OS, Windows 10+. |
| Operability | Every device problem shows up in the web app, the menu bar icon, and `printbetter doctor`. |
| Accessibility | Keyboard and screen reader friendly; WCAG 2.2 AA contrast in every theme. |

## 8. Key flows

1. **First run.** The owner deploys the Worker with one script, opens the setup link, and creates the first account (or lets an AI assistant do it over MCP).
2. **Add a computer.** Copy one command (or double-click the macOS installer), approve the device code in the browser. Printers it finds appear in the web app, added automatically under the `smart` policy.
3. **Print from a laptop away from home.** The home printer is already in Cmd+P. The job goes to the server, waits if the home device is asleep, and prints when it wakes. The laptop shows progress in the print queue.
4. **Fix a problem remotely.** The helper sees "Out of paper in Tray 2" on the dashboard, asks someone at home to refill it, and the job resumes on its own.
5. **Ask an assistant.** "Print this PDF two-sided on the office printer and tell me when it's done" works through MCP with the user's own permissions.

## 9. Success metrics

| Metric | Target |
|---|---|
| Time from deploy to first printed page | Under 10 minutes |
| Steps to add a computer | One command or installer, plus one browser approval |
| Job success rate, excluding printer hardware faults | 99.5% or better |
| Jobs lost without a reason | Zero |
| Duplicate printers in a print dialog | Zero |
| Support questions that need a terminal | Zero for the everyday printer persona |

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Printers vary widely in IPP support | Multiple routes per printer, conversion fallbacks, and capability probing before each job |
| macOS and Linux print systems change between releases | Queues are created with standard `lpadmin` and IPP Everywhere; only queues the client created are ever changed |
| A compromised device token | Tokens are per device, scoped to one workspace, revocable from the web app, and stored hashed on the server |
| Self-hosters on an older server version | Clients and server share a versioned protocol; release notes call out deploy order |
| Cloudflare platform limits | Documents stream to R2; the Durable Object stores only socket state; D1 holds the rest |

## 11. Release plan

- **0.1.x (shipped):** server, web app, accounts, MCP, client for macOS, Linux, and Windows, remote printers on macOS and Linux, automatic updates.
- **0.1.3 (next):** supply levels and full options in native print dialogs, per-computer printer control and default printer from the web app, unattended updates for the Linux system service.
- **Phase 2:** microcontroller bridge firmware, remote printers on Windows, signed Windows builds, a container build for non-Cloudflare hosts, and a public IPP endpoint on the server.

## 12. Open questions

- Should a computer's default printer set in the web app win over one changed locally, or should the last change win?
- Is a public IPP endpoint worth the extra attack surface, or do native remote printers cover the need?
- Which microcontroller boards to support first, and over which transport (Wi-Fi only, or Ethernet too)?
