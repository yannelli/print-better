# Remote printers on desktops

Goal: every added printer in a workspace that lives on *another* device shows up on a paired Mac (and Linux desktop) as a normal local printer: listed in System Settings → Printers & Scanners, selectable in every app's Cmd+P dialog, with job progress in the system print queue. Nothing to configure; it is on by default.

## How it works
```
App (Cmd+P) → CUPS queue "pb_<printerId>" → ipp://127.0.0.1:8632/ipp/print/<slug>
  → printbetter daemon (loopback IPP server, never advertised)
  → POST /api/client/jobs + PUT file → WorkspaceHub → device that owns the printer → printer
```
- The daemon reuses `pb_print::share` on loopback only, with no DNS-SD, accepting only the server's document types (PDF, JPEG, PNG). macOS and CUPS send PDF.
- CUPS queues are created with `lpadmin ... -m everywhere`, which queries our loopback IPP server, so the server must be listening before queues are added.
- If the daemon is down, CUPS holds the job and retries on its own. If the server is unreachable, the loopback server refuses with "not ready" (IPP `server-error-service-unavailable`) so CUPS keeps retrying; nothing is lost.
- If the owning device is offline, the job is still accepted: it waits on the server (normal `queued` semantics) and prints when that device reconnects. The queue's state message says so.

## Protocol additions (v1, additive; older clients ignore unknown messages)

Constant: `REMOTE_PRINT_PORT = 8632` (`server/shared/protocol.ts`, `client/crates/app/src/proto.rs`).

Hiding printers and choosing the default printer add `direct` and `system_printers`; see "Choosing printers and the default printer".

`ClientSettings.remotePrinters: boolean`, default `true` (server default, client default, settings LWW like every other key).

Server → client:
```ts
export interface RemotePrinter {
  id: string                 // server printer id
  name: string               // display name (alias if set)
  location: string | null
  makeModel: string | null
  uuid: string | null        // the printer's own uuid, so a device that reaches it natively can skip it
  clientName: string         // device that owns it
  online: boolean            // owning client connected AND printer state !== 'offline'
  state: PrinterState
  capabilities: Capabilities
  defaults: JobOptions
  supplies: Supply[]         // from the printer's last status; older servers omit it
}
export interface RemotePrintersMsg { type: 'remote_printers'; printers: RemotePrinter[] }
```
- Contains every `added` printer in the workspace whose `clientId` is not the receiving client. Full snapshot each time.
- Sent right after `welcome`, then whenever that snapshot would change for a client (printer added/removed/renamed/edited, status state or supply level change, owning client connects or disconnects). Coalescing a burst into one send is fine; sending only on real change is required (no per-poll spam).

## Client job endpoints (Bearer `pbc_…`)
| Method + path | Body → response |
|---|---|
| `POST /api/client/jobs` | `{ printerId, title?, contentType, size, fileName?, options?, requestedBy? }` → 201 `{ job, uploadUrl }` (status `uploading`). `uploadUrl` is absolute (`<origin>/api/client/jobs/:id/file`). |
| `PUT /api/client/jobs/:id/file` | raw body, `Content-Type` = declared type, exactly `size` bytes → `{ job }` now `queued` and dispatched |
| `GET /api/client/jobs/:id` | → `{ job }` |
| `POST /api/client/jobs/:id/cancel` | → `{ job }` |

- Only jobs this client created are visible to it (404 otherwise). The printer must be `added` and in the client's workspace (404 `printer_not_found` otherwise). Types: `DOC_TYPES`; size limit: workspace `maxUploadMb` (413 `too_large`). `options` validated exactly like the REST API. `requestedBy` is the OS user name from IPP `requesting-user-name` (≤ 100 chars).
- Same service code as REST uploads (`queueJob`, `uploadJobFile`), not a parallel path.
- Jobs record `source = 'device'`, `source_client_id`, `requested_by`. `Job` gains `sourceClientId: string | null`, `sourceClientName: string | null`, `requestedBy: string | null`. The web UI shows "From <device> (<requestedBy>)" in job lists and detail.
- Migration `0003_device_jobs.sql`: adds `'device'` to the `jobs.source` CHECK (table rebuild, keep data and indexes) plus the two columns.

## Client behavior
- Active when: paired, `settings.remotePrinters`, and the platform has CUPS `lpadmin` (macOS, Linux). Windows: not yet; status reports "Not available on Windows yet".
- Loopback IPP server on `127.0.0.1:8632`, started before any queue is added. Printer key = server printer id; the `PrinterReport` passed to the share server is built from `RemotePrinter`.
- Sink: `submit` refuses with "not ready" when the session is not connected; otherwise it returns a local id at once and a task uploads (create, PUT, delete the spool file), then polls `GET /api/client/jobs/:id` every 2 s until terminal. State map: `uploading|queued|dispatched` → pending (message "Waiting for <clientName>" when that device is offline), `printing` → processing, `completed` → completed, `failed` → aborted with the server's message, `canceled` → canceled. `cancel` → `POST …/cancel`.
- Queue sync (diff, not rebuild): name `pb_<printerId>`; `lpadmin -p pb_<id> -E -v ipp://127.0.0.1:8632/ipp/print/<slug> -m everywhere -D "<name>" -L "<location or clientName> (via Print Better)" -o printer-is-shared=false`. Update `-D`/`-L` when they change. Each queue record keeps a fingerprint of what the PPD is generated from (capabilities, make and model, and a version of the loopback attributes); when it changes, or a record has none, the update adds `-m everywhere` so CUPS regenerates the PPD. Levels, state and online status never regenerate it. Remove (`lpadmin -x`) when a printer leaves the snapshot, when `remotePrinters` turns off, and on unpair. Only ever touch queues recorded as managed in local state and named `pb_*`. Daemon shutdown keeps queues.
- macOS: after each `-m everywhere`, the daemon adds `*APAirPrint: True` to the generated PPD (`lpadmin -p pb_<id> -P <file>`). Printers & Scanners reads Supply Levels only for queues marked AirPrint, and then asks the device URI (the loopback server) through PrintKit, which also requires `urf-supported`. Failing to mark is logged and not fatal: the queue prints either way.
- Status: local `/api/status` gains `remotePrinters: { active: boolean, error: string | null, printers: [{ id, name, queue, online }] }`; the status page, tray, and `doctor` surface errors (e.g. lpadmin permission denied).
- CLI: `printbetter config set remotePrinters false` works through the existing settings path.

## Options and supplies

The loopback server describes each printer from its `RemotePrinter`, so `lpadmin -m everywhere` builds a PPD with the same choices a native AirPrint queue for that printer gets. Every choice maps to a job option the owning device applies:

| macOS print dialog (PPD) | IPP on the loopback | Job option | Offered when |
|---|---|---|---|
| Paper Size (`PageSize`) | `media` / `media-col.media-size` | `media` | always (`capabilities.media`, else Letter and A4) |
| Paper Feed (`InputSlot`) | `media-col.media-source` | `source` (`auto` means none) | `capabilities.sources` lists more than one |
| Paper Type (`MediaType`) | `media-col.media-type` | `mediaType` | `capabilities.mediaTypes` has more than one standard keyword (vendor ones such as `com.hp.ecosmart-lite` have no label in CUPS and are left out) |
| Quality (`cupsPrintQuality`) | `print-quality` | `quality` | `capabilities.qualities`, or all three when unknown |
| Two-Sided (`Duplex`) | `sides` | `sides` | `capabilities.duplex` |
| Color (`ColorModel`) | `print-color-mode` | `colorMode` | grayscale only unless `capabilities.color` |

On the owning device, IPP routes send `source` and `mediaType` inside `media-col` (with the paper size moved into it) and only when the printer lists them in `media-source-supported` / `media-type-supported`; other routes ignore them.

Supplies: `marker-names`, `marker-types`, `marker-colors`, `marker-levels` come from `RemotePrinter.supplies`. `printer-more-info` and `printer-supply-info-uri` point at the printer's page in the web app (`<server>/w/<workspaceId>/printers/<printerId>`); cupsd copies the first into the PPD as `*APSupplies`, which is where the **Supplies** button goes. The loopback lists `urf-supported` without accepting URF, so CUPS still sends PDF.

macOS's other supply source, cupsd's cached `marker-*` refreshed by a CUPS `ReportLevels` command job, is never used for these queues: it needs `printer-commands` with `ReportLevels`, cupsd does not accept `application/vnd.cups-command` for an everywhere queue, and the loopback refuses anything but PDF, JPEG and PNG, so a command file can never turn into a print job.

New options reach the Mac without a restart: the owning device re-probes every printer over IPP on each discovery (at start, every 10 minutes, and on demand), reports the inventory when anything but status changed, the hub sends a new `remote_printers`, and the changed fingerprint regenerates the queue's PPD.

## Choosing printers and the default printer

A desktop's page in the web app has a **Printers on this computer** section (macOS and Linux; Windows says "Coming soon"). It lists every added printer on the workspace's other devices, each with a switch to show or hide it on this computer and its live state there, plus a **Default printer** choice. It needs Print Better 0.1.3 or later on the device; older devices never report, so the section asks to update them.

Settings (additive, LWW like every other key; also `printbetter config set remotePrintersHidden pr_1,pr_2` and `printbetter config set defaultPrinter pr_1|none`):

| Key | Default | Meaning |
|---|---|---|
| `remotePrintersHidden: string[]` | `[]` | Workspace printer ids this computer does not add. Their `pb_` queues are removed. |
| `defaultPrinter: string \| null` | `null` | Workspace printer to make this computer's default; `null` never touches the default. |

The device reports what it did with `system_printers` (below); the hub stores it on the device row (`clients.system_printers`, migration `0004`) and sends browsers a `client` event, so `Client.systemPrinters` is `null` until a device reports. States per printer: `added` (its `pb_` queue), `direct` (reached without Print Better, so never added twice; `queue` is the computer's own queue for it when there is one), `hidden`, `waiting` (not added yet), `error` (lpadmin failed; the message is in `error`).

`remote_printers` gains `direct?: { id, uuid }[]`: added printers on other devices that the receiver reports itself, so the server leaves them out of `printers`. With the printers the device sees on Bonjour, they are the `direct` ones.

Default printer rules (daemon):
- The queue for printer `id` is its `pb_` queue when added; when reached directly, the computer's own queue whose device URI names the printer's uuid (`dnssd://…?uuid=…`, from `lpstat -v`). With no such queue nothing changes and the report says `needs_queue`: the web app asks to add the printer in System Settings > Printers & Scanners first. Adding a second copy would list the printer twice.
- `lpadmin -d <queue>` runs only when `lpstat -d` names another queue. The daemon records the queue and what `lpstat -d` said right after (`state.json`).
- It never re-asserts. If the default later differs from that record while the recorded queue still exists, someone changed it on the computer: the local choice wins, and the daemon sets `defaultPrinter` back to `null` ("Don't change"), which syncs to the server. Picking the printer again in the web app applies it again. A default that moved because Print Better removed its own queue (the printer went away, or the computer now reaches it directly) is not a local change; the daemon follows the printer to its new queue.
- Turning remote printers off leaves the default alone.

macOS "Last Printer Used": with **System Settings > Printers & Scanners > Default printer** set to **Last Printer Used** (the macOS default), the print window starts on the last printer used on the current network and ignores the CUPS default. CUPS reads `UseLastPrinter` from `org.cups.PrintingPrefs`, first the user's domain (`~/Library/Preferences`), then `/Library/Preferences`, and treats a missing value as on; the last printer per network is `LastUsedPrinters` in the user's domain. A user's own `~/.cups/lpoptions` default also wins over the system default. A root daemon could write those preferences for the person at the login window, but that would change their settings behind their back on every pick, so it doesn't: it reads `UseLastPrinter` (`lastUsed` in the report) and the web app tells the user to set **Default printer** to the chosen printer in System Settings.
