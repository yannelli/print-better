# Architecture

Print Better has two programs: a **server** (one Cloudflare Worker that also serves the web app) and a **client** (a Rust daemon that runs next to printers). Clients dial out to the server over WebSocket, so nothing on the printer's network needs to be exposed.

```
 browser / API / MCP / email ──HTTPS──▶ Worker ──RPC──▶ WorkspaceHub DO ◀──WSS── client ──IPP/USB/OS──▶ printer
                                          │  D1 (state)   R2 (documents, downloads)
```

## Repo layout
```
server/                 Vite project: React SPA + Worker in one deployable
  wrangler.jsonc        bindings: DB (D1), FILES (R2), HUB (Durable Object), assets, cron (operators may add an EMAIL send binding)
  migrations/           D1 SQL migrations (0001_init.sql is the schema contract; 0002_oauth.sql adds api_tokens.resource)
  shared/               types shared by SPA and Worker (types.ts, protocol.ts, extensions.ts, access.ts)
  worker/               Worker: router, auth, api, hub, mcp, oauth, email, install scripts
  worker/extensions/    optional modules (docs/extensions.md): switches, hook registries, one folder per extension
  src/                  SPA (React + shadcn)
client/                 Cargo workspace
  crates/print          pb-print: model, IPP, discovery, conversion, backends, LAN share
  crates/app            printbetter: CLI, daemon, server session, job queue, tray, service install
  packaging/            Info.plist, entitlements, launchd/systemd/udev files
scripts/                release (cross-build, sign, notarize, upload), deploy, dev helpers
docs/                   decisions, architecture, protocol, api, mcp, research notes
```

## Server

- **Worker** (`server/worker`): stateless HTTP. It authenticates every request:
  - the REST API takes the session cookie or a `pbt_` personal token
  - `/mcp` takes a `pbt_` token or a `pbo_` OAuth access token issued for it
  - device endpoints take a `pbc_` client token

  Permission checks (role and token scope) run in the service layer that REST and MCP share. The Worker reads and writes D1, streams documents to and from R2, and calls the hub for anything realtime.
- **WorkspaceHub Durable Object**: one per workspace (`idFromName(workspaceId)`). It holds the WebSockets of that workspace's clients and open browser tabs, using the hibernation API. It handles:
  - delivering jobs
  - relaying commands and their results
  - applying client reports to D1
  - fanning out change events to browsers
  - sweeping stale sockets with an alarm

  The hub keeps only socket attachments and in-flight command promises. D1 holds the state.
- **D1**: users, credentials, workspaces, clients, printers, jobs, tokens, OAuth clients, settings, audit log, extension switches (`workspace_extensions`; instance availability is the `extensions` settings row) and printer access groups, roles and grants. Schema: `server/migrations/`.
- **R2** (`FILES`): `jobs/<workspaceId>/<jobId>` documents (purged by cron after `keepDocumentsHours`, default 24), `downloads/<version>/<file>` client builds plus `downloads/latest.json`.
- **Cron** (every 15 min):
  - purges documents past `keepDocumentsHours`
  - deletes expired sessions, challenges, enrollment tokens, device codes, API/OAuth tokens and unaccepted invites
  - drops OAuth client records older than 30 days that have no tokens
  - fails uploads abandoned for an hour, and jobs with no progress for `jobTimeoutHours`
  - marks clients offline whose sockets vanished
- **Email** (off by default): `email()` handler for Cloudflare Email Routing and `POST /api/hooks/resend` for Resend inbound. Outbound mail (invites, resets, alerts) uses Resend or Cloudflare's send-email binding when configured. Without it, invite links are copy/paste and resets go through recovery codes or an admin.
- **Extensions** (`server/worker/extensions/`): optional modules, active in a workspace only when a server admin made them available and an owner turned them on. The core asks them through hooks (for example the printer policy behind every printer and job check) and keeps its built-in rules when none is active.
- **MCP** (`/mcp`): stateless streamable-HTTP MCP server that speaks both 2026-07-28 and the 2025 `initialize` era. Its tools cover everything the UI can do (see `docs/mcp.md`). Auth: the built-in OAuth 2.1 server (for Claude/ChatGPT connectors) or a personal API token.
- **Install endpoints**: `/install.sh`, `/install.ps1`, `/dl/<file>`, templated with the server origin. Tokens are passed as script arguments, never baked into cached responses.

## Web app

The React SPA is served as static assets with SPA fallback. `run_worker_first` covers `/api/*`, `/mcp*`, `/.well-known/*`, `/install.*`, `/dl/*` and the OAuth endpoints (`/oauth/authorize`, `/token`, `/register`, `/revoke`; `/oauth/consent` is an SPA page).

Realtime updates come over `GET /api/workspaces/:ws/events` (a WebSocket to the hub).

Look: Vercel-style monochrome (Geist, 1px borders, dense type) mixed with Google Material 3 Expressive (tonal surfaces, rounded shapes, springy motion). Themes are light, dark or system, with a user-selectable accent.

## Client

One binary, `printbetter`, two crates:

- **pb-print** (library, no knowledge of the server):
  - `model`: serde types mirrored from `server/shared/types.ts`.
  - `ipp`: RFC 8010 codec and client over HTTP/1.1 (+TLS, trust-on-first-use for printer certs).
  - `discovery`: mDNS/DNS-SD, SNMP broadcast, USB printer class, OS queues (CUPS on macOS/Linux, spooler on Windows). Merges results into one `PrinterReport` per physical printer with ordered `routes`.
  - `convert`: sniff formats; PDF passthrough when the printer takes PDF; otherwise rasterize (pure-Rust PDF renderer) and encode PWG Raster, URF, PCL or PostScript; images and plain text supported.
  - backends: `ipps`/`ipp`, `socket` (9100), `lpd`, `usb` (raw printer class), `os` (CUPS via IPP on localhost; Windows spooler RAW passthrough or GDI page bitmaps for any driver).
  - `share`: optional IPP Everywhere/AirPrint server + DNS-SD advertisement for LAN sharing; also runs loopback-only, never advertised, behind remote printer queues.
- **printbetter** (binary): CLI, config/state files, pairing, server session (WSS + heartbeat + reconnect), persisted job queue, local status/pairing page on `127.0.0.1:47631`, tray, service install, LAN-share glue, self-update (`update`, plus the daemon's supervised updater; see Updates in `cli.md`).

Remote printers (macOS, Linux; `remote-printers.md`): The hub sends each desktop a `remote_printers` snapshot of added printers on other devices. The daemon serves them on `127.0.0.1:8632` and keeps CUPS queues `pb_<printerId>` in step with `lpadmin` (only queues it recorded as its own). It turns each job CUPS hands it into a `POST /api/client/jobs` upload that the hub routes to the owning device.

Threads: The tray (when enabled) owns the main thread, because AppKit requires it, and the tokio runtime runs on a worker thread. With the tray off, tokio runs on main.

### Paths
| OS | config + state | logs |
|---|---|---|
| macOS | `~/Library/Application Support/Print Better/` | `~/Library/Logs/Print Better/` |
| Linux (user) | `$XDG_CONFIG_HOME/printbetter/`, `$XDG_STATE_HOME/printbetter/` | state dir + stderr |
| Linux (system) | `/etc/printbetter/`, `/var/lib/printbetter/` | journald |
| Windows | `%LOCALAPPDATA%\Print Better\` | same dir `\logs` |

`PRINTBETTER_HOME` overrides all of these paths (used by tests and portable installs).

## Pairing

1. **Enrollment token** (scripts, Pi): The web UI mints `pbe_…` (default 24 h, single use). `install.sh`/`install.ps1` installs the binary and runs `printbetter pair --server <origin> --token pbe_…`, which calls `POST /api/client/enroll` and stores the returned `pbc_…` device token.
2. **Device code** (double-clicked app/pkg): The app's local page asks for the server address, calls `POST /api/client/device/code`, and opens `<server>/device?code=ABCD-EFGH`. A signed-in user picks the workspace and approves. The client polls `/api/client/device/token`.
3. The web UI can also hand the local page a link: `http://127.0.0.1:47631/pair#server=<origin>&token=pbe_…` (the fragment keeps the token out of logs). The local page posts it to the daemon.

## Job lifecycle and reliability

`queued → dispatched → printing → completed | failed | canceled`

1. Create: The API validates the printer and format and writes the job row. The document goes to R2 (a two-step upload for large files), and the hub is asked to dispatch.
2. Deliver (at-least-once): The hub sends `job` to the owning client if it's connected, and re-sends every `queued`/`dispatched` job after each `hello`. While the client is connected, the hub re-offers any job still `queued` after a minute, every 30 s. The client dedups by job id (persisted), acks with `job_status: dispatched`, downloads the file over HTTPS with its device token, and verifies SHA-256.
3. Print: The client picks the first healthy route, converts if needed, submits, then follows the printer job (IPP job state) to completion.
   - Transient failures (printer offline, out of paper, connection refused) keep the job `dispatched` with a human message and retry with backoff: 5 s doubling to 5 min, giving up after `jobTimeoutHours` (default 24). The next route is tried on connection failures.
   - Permanent failures (unsupported format, rejected) go to `failed`.
4. Status flows back as `job_status`. The server ignores regressions and duplicate terminal reports. Terminal state is final; "retry" creates a fresh attempt on the same job id with `attempts + 1`.
5. Cancel: If the job isn't dispatched yet, or the device is offline, the server cancels it directly. Otherwise it sends `cancel` and the client aborts (IPP Cancel-Job when already submitted).

Printer health: The client polls added printers every 60 s (IPP Get-Printer-Attributes or SNMP) and pushes `printer_status` on change (state, reasons like `media-empty`/`toner-low`, supply levels). Discovery reruns every 10 min and on demand.

Auto-add (`autoAdd`, a workspace setting the client may override):
- `smart` (default): adds printers attached to the client (USB/OS-local), and network printers when the client found at most 3
- `all`
- `none`

Everything else stays `discovered` for one-click adding.

## Security model

- Every bearer secret is random (≥160 bits), shown once, and stored as SHA-256. Prefixes:
  - `pbs_`: session cookie value
  - `pbc_`: client
  - `pbe_`: enrollment
  - `pbi_`: invite
  - `pbp_`: password reset
  - `pbv_`: email verification
  - `pbd_`: device code
  - `pbt_`: personal API token
  - `pbo_`/`pbr_`: OAuth access/refresh
- Passwords: scrypt (N=2^15, r=8, p=3) via `node:crypto` over HMAC-SHA256 of the password keyed with a server pepper (`AUTH_PEPPER` secret). Hash strings are self-describing and rehashed at login when the parameters change.
- Tokens carry scopes (`read`, `write`, `print`; PATs hold all three), checked in the service layer. OAuth access tokens are bound to `<origin>/mcp` and refused by the REST API. Refresh tokens rotate, and reusing one revokes the whole connection.
- Instance secrets (SSO client secrets, email API key, webhook secret) are encrypted with AES-GCM under a key derived from `APP_SECRET`.
- Cookie auth: `HttpOnly; Secure; SameSite=Lax`. Non-GET requests must carry a matching `Origin`.
- Client tokens can only read jobs for that client's printers and only connect to their own workspace hub.
- Email-to-print: per-workspace allowlist (default: verified emails of members), DMARC pass required when the header is present, per-printer alias.
- The local client API binds to loopback. Mutating requests need `Content-Type: application/json` and a loopback/absent `Origin`.
- Audit log records every mutation with actor type (user, token, client, email, system).
