# Client protocol (v1)

Canonical message shapes: `server/shared/protocol.ts` (TypeScript) and `client/crates/app/src/proto.rs` (Rust). This file defines the semantics. JSON is camelCase; message `type` values are snake_case.

## HTTP endpoints used by the client

All responses are JSON unless noted. Errors: `{ "error": { "code", "message" } }`.

| Method + path | Auth | Body → response |
|---|---|---|
| `POST /api/client/enroll` | none (token in body) | `{ token: "pbe_…", hostname, os, arch, version, name? }` → `{ clientId, workspaceId, name, token: "pbc_…" }` |
| `POST /api/client/device/code` | none | `{ hostname, os, arch, version }` → `{ deviceCode, userCode, verificationUri, verificationUriComplete, interval, expiresIn }` |
| `POST /api/client/device/token` | none | `{ deviceCode }` → 200 `{ clientId, workspaceId, name, token }`, or 400 with code `authorization_pending`, `slow_down`, `access_denied`, `expired_token` |
| `GET /api/client/ws` | `Bearer pbc_…` | WebSocket upgrade; header `X-PB-Protocol: 1` |
| `GET /api/client/jobs/:id/file` | `Bearer pbc_…` | document bytes; `Content-Type`, `Content-Length`, `X-PB-SHA256` |
| `POST /api/client/jobs` | `Bearer pbc_…` | `{ printerId, title?, contentType, size, fileName?, options?, requestedBy? }` → 201 `{ job, uploadUrl }` (status `uploading`; `uploadUrl` is absolute, `<origin>/api/client/jobs/:id/file`) |
| `PUT /api/client/jobs/:id/file` | `Bearer pbc_…` | raw body, `Content-Type` = declared type (else 415 `unsupported_type`), exactly `size` bytes (else 400 `size_mismatch`) → `{ job }` now `queued` and dispatched |
| `GET /api/client/jobs/:id` | `Bearer pbc_…` | `{ job }` |
| `POST /api/client/jobs/:id/cancel` | `Bearer pbc_…` | `{ job }` (409 `job_finished` when already terminal) |
| `GET /api/client/latest?os=&arch=&kind=` | `Bearer pbc_…` | `{ version, url, sha256, size }` or 404 `no_build`. `kind` (macOS only): `pkg` for the machine-wide install (`macos-pkg`), `app` or absent for the per-user zip (`macos-universal`); Linux gets its arch tarball (`armv6`/`armv7` for 32-bit ARM) |

- Enrollment tokens are single-use by default; enrolling consumes one use atomically.
- Device codes: `userCode` is 8 chars from `BCDFGHJKLMNPQRSTVWXZ` shown as `XXXX-XXXX`, 10 min lifetime, poll interval 5 s; a poll less than 4 s after the previous one (1 s of slack) returns `slow_down`, and the client then adds 5 s to its interval (RFC 8628).
- A revoked client gets 401 on every endpoint and should drop its credentials only after the user confirms (`printbetter unpair`), so a server misconfiguration cannot silently orphan devices.

## WebSocket session

1. Client connects, sends `hello` first. Anything else first closes the socket with code 4400.
2. Hub replies `welcome` (identity, settings, printer configs), then `remote_printers`, then re-offers every `queued`/`dispatched` job for this client as `job` messages, oldest first. While the client is connected, a job still `queued` a minute after it was queued is offered again on every alarm sweep (30 s) until the client acks it.
3. Client sends a `printers` snapshot after its first discovery and whenever inventory changes; hub replies `printer_config`.
4. Keepalive: client sends the text frame `ping` every 25 s; hub auto-responds `pong` without waking. No `pong` within 10 s → client reconnects. Hub closes sockets idle for 90 s (alarm sweep).
5. Reconnect: jittered exponential backoff 1 s → 60 s cap; reset after 60 s connected. 401 on upgrade → stop and surface "unpaired" in tray/status page.
6. One live socket per client: a new connection closes the old one with code 4409.

Close codes: 4400 protocol error, 4401 unauthorized/revoked, 4409 replaced, 4500 server error.

## Inventory

- `PrinterReport.key` is stable per client, derived in this order: `uuid:<printer-uuid>`, `usb:<vid>:<pid>:<serial>`, `os:<queue-name>`, `net:<host>:<port>`.
- The snapshot replaces this client's previous report. Printers missing from it keep their row and settings but get `status.state = "offline"`; users delete them explicitly.
- New keys become `discovered`; auto-add policy (`smart`/`all`/`none`, see architecture.md) may mark them `added`.
- `printer_status` carries only changes from the 60 s health poll.
- `printer_config` tells the client which printers are added (only added printers are health-polled, LAN-shared, and accept jobs), their names (used for LAN share names) and default job options.

## Jobs

- `job` is idempotent. Client persists `JobOffer` before acking with `job_status: dispatched`. If the id is already known locally, it re-sends the latest status instead of printing again.
- `job_status.attempt` echoes `JobOffer.attempt` (omitted means the job's current attempt), so a late report from an earlier attempt cannot overwrite a retry.
- Client fetches `fileUrl` with its token, verifies `sha256`, merges `options` over printer `defaults`.
- Progress: `dispatched` (accepted, possibly waiting for the printer, `message` explains) → `printing` (submitted to the device) → `completed` (with `pages` when known) | `failed` (`message` required) | `canceled`.
- Hub rules: terminal states are final; a status earlier in the order than the current one is ignored, except `printing → dispatched`, which a device sends when it backs off to retry (transient errors guarantee nothing reached the printer); reports for any `attempt` other than the job's current one are ignored.
- `cancel`: client aborts download/convert, or sends IPP Cancel-Job when already submitted, then reports `canceled`. If the printer already finished, it reports `completed`.
- Paused client (`settings.paused`): jobs are acked and held with message "Paused on <client name>".
- Local retention: terminal job ids are kept 7 days for dedup; spooled files are deleted on terminal state.

## Commands

`command` → exactly one `result` with the same `id`. Hub waits up to 20 s, then reports a timeout to the caller.

| name | args | result data |
|---|---|---|
| `discover` | `{}` | `{ count }` (also sends a fresh `printers` snapshot first) |
| `refresh` | `{ key? }` | `{ count }` (pushes `printer_status` for changes) |
| `identify` | `{ key }` | `{}` (IPP Identify-Printer; error if unsupported) |
| `logs` | `{ lines?: number }` | `{ lines: string[] }` (default 200, max 2000) |
| `diagnose` | `{}` | `{ checks: { name, ok, detail }[] }` (server reachability, clock skew, discovery, permissions, per-printer route probes) |
| `restart` | `{}` | `{}` then the daemon restarts itself |
| `update` | `{}` | `{ from, to }` once a newer release is found; the device then downloads, verifies and installs it in the background and restarts into `to`. Error when already current (never downgrades) or the install can't update itself (Windows) |
| `unpair` | `{}` | `{}` then the client deletes credentials and stops. Sent only when the device is removed (`DELETE …/clients/:id` or MCP `remove_device`), just before the hub closes the socket with 4401; the commands endpoint refuses it |

## Remote printers

Desktops show the workspace's printers on other devices as local printers (docs/remote-printers.md). The loopback IPP server for them listens on `REMOTE_PRINT_PORT` (8632).

- `remote_printers` is a full snapshot: every `added` printer in the workspace whose device is not the receiver, sorted by name. `online` is true when the owning device is connected and the printer state is not `offline`. The hub sends it after every `welcome` and again whenever that client's snapshot changes (printer added, removed, renamed or edited, a state or supply level change, the owning device connecting or disconnecting). Bursts may coalesce; an unchanged snapshot is never re-sent, so health polls that change nothing produce no message.
- Each printer carries `supplies` from its last status. Capabilities may include `sources` (trays), `mediaTypes` and `qualities`; devices that cannot tell omit them, and jobs may then carry `source` and `mediaType`.
- The server always sends the snapshot; `settings.remotePrinters` (default `true`) tells the client whether to create the system queues.
- Printing: `POST /api/client/jobs`, then `PUT` the file to `uploadUrl`, then poll `GET /api/client/jobs/:id`. The printer must be `added` and in the device's workspace, else 404 `printer_not_found`. Types are `DOC_TYPES`; a `size` over the workspace `maxUploadMb` is 413 `too_large`; `options` are validated like `POST /workspaces/:ws/jobs`. `title` (200), `fileName` (255) and `requestedBy` (100, the IPP `requesting-user-name`) are trimmed and clipped to those lengths rather than refused.
- These jobs record source `device`, `sourceClientId`, `sourceClientName` and `requestedBy`, and go through the same queue, dispatch, status and cancel rules as any other job. A device sees and cancels only jobs it created (404 otherwise). If the printer's device is offline the job waits `queued` until it reconnects.

## Settings

Server-owned with last-write-wins on `updatedAt`. The client applies `settings` from `welcome`/`settings` messages; local CLI changes (`printbetter tray off`, `printbetter pause`) are applied immediately, persisted, and sent as a client `settings` message (on reconnect if offline). The hub stores whichever `updatedAt` is newer and echoes the winner.

## LAN sharing

When `settings.lanSharing` is on, the client advertises each added printer with `lanShare: true` over DNS-SD and serves IPP on port 8631. Jobs received this way go through the same local queue and are reported with `lan_job` (history only; the server never re-dispatches them).
