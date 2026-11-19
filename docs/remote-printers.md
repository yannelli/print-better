# Remote Printers on Desktops

Goal: Every added printer in a workspace that lives on *another* device shows up on a paired Mac (and Linux desktop) as a normal local printer:
- listed in System Settings > Printers & Scanners
- selectable in every app's Cmd+P dialog
- with job progress in the system print queue

It is on by default, with nothing to configure.

## How It Works
```
App (Cmd+P) → CUPS queue "pb_<printerId>" → ipp://127.0.0.1:8632/ipp/print/<slug>
  → printbetter daemon (loopback IPP server, never advertised)
  → POST /api/client/jobs + PUT file → WorkspaceHub → device that owns the printer → printer
```
- The daemon reuses `pb_print::share` on loopback only, with no DNS-SD, and accepts only PDF, JPEG and PNG. macOS and CUPS send PDF.
- CUPS queues are created with `lpadmin ... -m everywhere`, which queries our loopback IPP server, so the server must be listening before queues are added.
- If the daemon is down, CUPS holds the job and retries on its own.
- If the server is unreachable, the loopback server refuses with "not ready" (IPP `server-error-service-unavailable`), so CUPS keeps retrying and nothing is lost.
- If the owning device is offline, the job is still accepted. It waits on the server (normal `queued` semantics) and prints when that device reconnects. The queue's state message says so.

## Protocol Additions (v1, Additive; Older Clients Ignore Unknown Messages)

Constant: `REMOTE_PRINT_PORT = 8632` (`server/shared/protocol.ts`, `client/crates/app/src/proto.rs`).

Hiding printers and choosing the default printer add `direct` and `system_printers`; see "Choosing Printers and the Default Printer".

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
- The message contains every `added` printer in the workspace whose `clientId` is not the receiving client, as a full snapshot each time.
- The hub sends it right after `welcome`, then whenever that snapshot would change for a client: a printer added/removed/renamed/edited, a status state or supply level change, or the owning client connecting or disconnecting.
- Coalescing a burst into 1 send is fine. Sending only on a real change is required (no per-poll spam).

## Client Job Endpoints (Bearer `pbc_…`)
| Method + path | Body → response |
|---|---|
| `POST /api/client/jobs` | `{ printerId, title?, contentType, size, fileName?, options?, requestedBy? }` → 201 `{ job, uploadUrl }` (status `uploading`). `uploadUrl` is absolute (`<origin>/api/client/jobs/:id/file`). |
| `PUT /api/client/jobs/:id/file` | raw body, `Content-Type` = declared type, exactly `size` bytes → `{ job }` now `queued` and dispatched |
| `GET /api/client/jobs/:id` | → `{ job }` |
| `POST /api/client/jobs/:id/cancel` | → `{ job }` |

- Only jobs this client created are visible to it (404 otherwise).
- The printer must be `added` and in the client's workspace (404 `printer_not_found` otherwise).
- Types: `DOC_TYPES`. Size limit: workspace `maxUploadMb` (413 `too_large`).
- `options` are validated exactly like the REST API.
- `requestedBy` is the OS user name from IPP `requesting-user-name` (≤ 100 chars).
- These endpoints run the same service code as REST uploads (`queueJob`, `uploadJobFile`).
- Jobs record `source = 'device'`, `source_client_id` and `requested_by`. `Job` gains `sourceClientId: string | null`, `sourceClientName: string | null` and `requestedBy: string | null`. The web UI shows "From <device> (<requestedBy>)" in job lists and detail.
- Migration `0003_device_jobs.sql` adds `'device'` to the `jobs.source` CHECK (a table rebuild that keeps data and indexes), plus the 2 columns.

## Client Behavior
- Remote printers are active when the client is paired, `settings.remotePrinters` is on, and the platform has CUPS `lpadmin` (macOS, Linux). Windows isn't supported yet; status reports "Not available on Windows yet".
- The loopback IPP server listens on `127.0.0.1:8632` and starts before any queue is added. The printer key is the server printer id, and the `PrinterReport` passed to the share server is built from `RemotePrinter`.
- Sink:
  - `submit` refuses with "not ready" when the session is not connected. Otherwise it returns a local id at once, and a task uploads the job (create, PUT, delete the spool file), then polls `GET /api/client/jobs/:id` every 2 s until terminal.
  - State map:
    - `uploading|queued|dispatched` → pending (message "Waiting for <clientName>" when that device is offline)
    - `printing` → processing
    - `completed` → completed (with a message: `job-completed-with-warnings` and that message)
    - `failed` → aborted with the server's message
    - `canceled` → canceled
  - `cancel` → `POST …/cancel`.
- Queue sync diffs the queues instead of rebuilding them:
  - Each queue is named `pb_<printerId>` and created with `lpadmin -p pb_<id> -E -v ipp://127.0.0.1:8632/ipp/print/<slug> -m everywhere -D "<name>" -L "<location or clientName> (via Print Better)" -o printer-is-shared=false`.
  - `-D`/`-L` are updated when they change.
  - Each queue record keeps a fingerprint of what the PPD is generated from (capabilities, make and model, and a version of the loopback attributes). When it changes, or a record has none, the update adds `-m everywhere` so CUPS regenerates the PPD. Levels, state and online status never regenerate it.
  - A queue is removed (`lpadmin -x`) when its printer leaves the snapshot, when `remotePrinters` turns off, and on unpair.
  - The daemon only ever touches queues recorded as managed in local state and named `pb_*`.
  - Daemon shutdown keeps queues.
- Taking over: When a queue to add already exists under its `pb_<id>` name and its device URI points at this loopback server (`ipp://127.0.0.1` or `localhost`, same port, an `/ipp/print/` path), it is recorded as managed with no PPD fingerprint and regenerated once (`-m everywhere`). Any other queue with that name is never touched.
- The device URI ends in `?uuid=<printer uuid>` when the server knows it. The loopback server routes on the path and ignores the query.
- macOS: After each `-m everywhere`, the daemon adds `*APAirPrint: True` to the generated PPD (`lpadmin -p pb_<id> -P <file>`). Printers & Scanners reads Supply Levels only for queues marked AirPrint, and then asks the device URI (the loopback server) through PrintKit, which also requires `urf-supported`. A failure to mark the PPD is logged and isn't fatal; the queue prints either way.
- Status: Local `/api/status` gains `remotePrinters: { active: boolean, error: string | null, printers: [{ id, name, queue, online }] }`. The status page, tray, and `doctor` surface errors (e.g. lpadmin permission denied).
- CLI: `printbetter config set remotePrinters false` works through the existing settings path.

## Options and Supplies

The loopback server describes each printer from its `RemotePrinter`, so `lpadmin -m everywhere` builds a PPD with the same choices a native AirPrint queue for that printer gets. Every choice maps to a job option the owning device applies:

| macOS print dialog (PPD) | IPP on the loopback | Job option | Offered when |
|---|---|---|---|
| Paper Size (`PageSize`) | `media` / `media-col.media-size` | `media` | always (`capabilities.media`, else Letter and A4) |
| Paper Feed (`InputSlot`) | `media-col.media-source` | `source` (`auto` means none) | `capabilities.sources` lists more than one |
| Paper Type (`MediaType`) | `media-col.media-type` | `mediaType` | `capabilities.mediaTypes` has more than one standard keyword (vendor ones such as `com.hp.ecosmart-lite` have no label in CUPS and are left out) |
| Quality (`cupsPrintQuality`) | `print-quality` | `quality` | `capabilities.qualities`, or all 3 when unknown |
| Two-Sided (`Duplex`) | `sides` | `sides` | `capabilities.duplex` |
| Color (`ColorModel`) | `print-color-mode` | `colorMode` | grayscale only unless `capabilities.color` |

On the owning device, IPP routes send `source` and `mediaType` inside `media-col` (with the paper size moved into it), and only when the printer lists them in `media-source-supported` / `media-type-supported`. Other routes ignore them.

Supplies: `marker-names`, `marker-types`, `marker-colors` and `marker-levels` come from `RemotePrinter.supplies`.

`printer-more-info` and `printer-supply-info-uri` point at the printer's page in the web app (`<server>/w/<workspaceId>/printers/<printerId>`). cupsd copies the first into the PPD as `*APSupplies`, the page the **Supplies** button opens.

The loopback lists `urf-supported` without accepting URF, so CUPS still sends PDF.

macOS has another supply source: cupsd's cached `marker-*`, refreshed by a CUPS `ReportLevels` command job. These queues never use it, because:
- it needs `printer-commands` with `ReportLevels`
- cupsd does not accept `application/vnd.cups-command` for an everywhere queue
- the loopback refuses anything but PDF, JPEG and PNG, so a command file can never turn into a print job

New options reach the Mac without a restart:
1. The owning device re-probes every printer over IPP on each discovery (at start, every 10 minutes, and on demand).
2. It reports the inventory when anything but status changed.
3. The hub sends a new `remote_printers`.
4. The changed fingerprint regenerates the queue's PPD.

## Choosing Printers and the Default Printer

A desktop's page in the web app has a **Printers on this computer** section (macOS and Linux; on Windows it says "Coming soon on Windows."). It lists every added printer on the workspace's other devices, each with its live state on this computer and a switch to show or hide it there. The section also has a **Default printer** choice.

The section needs Print Better 0.1.3 or later on the device. Older devices never report, so the section asks to update them.

Settings (additive, LWW like every other key):

| Key | Default | Meaning |
|---|---|---|
| `remotePrintersHidden: string[]` | `[]` | Workspace printer ids this computer does not add. Their `pb_` queues are removed. |
| `defaultPrinter: string \| null` | `null` | Workspace printer to make this computer's default; `null` never touches the default. |

The CLI sets the same keys: `printbetter config set remotePrintersHidden pr_1,pr_2` and `printbetter config set defaultPrinter pr_1|none`.

The device reports what it did with `system_printers` (below). The hub stores it on the device row (`clients.system_printers`, migration `0004`) and sends browsers a `client` event. `Client.systemPrinters` is `null` until a device reports.

Per printer:
- `state` is `added` (`queue` is its `pb_` queue), `hidden`, `waiting` (not added yet) or `error` (lpadmin failed; the message is in `error`).
- `installed` names a queue for the same printer set up on this computer without Print Better. Its device URI carries the printer's uuid (`dnssd://…?uuid=…`, from `lpstat -v`).
- `installedName` is that queue's description (`lpstat -l -p`), the name its print window shows.
- `direct` says this computer finds the printer itself.

`defaultName` is the default queue's description. The web app names printers that way and shows a queue id only as a small detail.

Printers this computer reaches itself are never dropped automatically. Seeing a printer on Bonjour, or reporting it in its own inventory, only sets `direct`. Even with an `installed` queue, the `pb_` queue stays (the web app says "Also installed directly as “Office laser”") until the user hides it.

Print Better's path is often faster than the printer's own AirPrint, and it keeps working away from that network.

`remote_printers` gains `direct?: { id, uuid }[]`, the printers in `printers` that the receiver reports itself.

Default printer rules (daemon):
- The queue for printer `id` is its `pb_` queue when added. When the printer is hidden, it's the computer's own `installed` queue, if there is one. Otherwise nothing changes and the report says `hidden`.
- `lpadmin -d <queue>` runs only when `lpstat -d` names another queue. The daemon records the queue and what `lpstat -d` said right after (`state.json`).
- It never re-asserts. If the default later differs from that record while the recorded queue still exists, someone changed it on the computer. The local choice wins, and the daemon sets `defaultPrinter` back to `null` ("Don't change"), which syncs to the server. Picking the printer again in the web app applies it again.
- A default that moved because Print Better removed its own queue (the printer went away, or it was hidden) is not a local change. The daemon follows the printer to its new queue.
- Turning remote printers off leaves the default alone.

macOS "Last Printer Used": With **System Settings > Printers & Scanners > Default printer** set to **Last Printer Used** (the macOS default), the print window starts on the last printer used on the current network and ignores the CUPS default.

CUPS reads `UseLastPrinter` from `org.cups.PrintingPrefs`, first in the user's domain (`~/Library/Preferences`), then in `/Library/Preferences`, and treats a missing value as on. The last printer per network is `LastUsedPrinters` in the user's domain. A user's own `~/.cups/lpoptions` default also wins over the system default.

A root daemon could write those preferences for the person at the login window, but that would change their settings behind their back on every pick, so the daemon doesn't. It reads `UseLastPrinter` (`lastUsed` in the report), and the web app tells the user to set **Default printer** to the chosen printer in System Settings.
