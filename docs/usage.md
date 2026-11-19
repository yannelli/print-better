# Usage and Job Checks

The shared foundation of [Print rules and limits](print-policies.md) and [Enterprise controls](enterprise.md): the check every job goes through before it is queued, page counting, usage, cycles, and prices. It is not an extension of its own. It works while **either** of them is active (`USAGE_EXTENSIONS` in `server/shared/usage.ts`) and does nothing while both are off.

## Inactive Means Invisible

With both extensions off, a job takes exactly today's path: no page counting, no checks, no usage rows. Every response is byte for byte the same. `server/test/usage-legacy.test.ts` traces every job path at the SQL level to prove it.

- `Job` has four optional fields: `policy`, `held`, `costCenterId` and `usage`. Each has its own nullable column in `jobs`, and `toJob` adds a field only when its column is set. Jobs created while both are off never get them.
- A job keeps what was recorded on it while an extension was on, like its status message. The web app shows these fields only while the extension that wrote them is active.
- The status `held` exists only with Enterprise controls. Turning it off cancels held jobs.
- Prices, the time zone, and usage history are kept while both are off.

## The Job Check

Every job is checked after printer access allowed it and before it is queued.

| Path | Where | When |
|---|---|---|
| `POST /jobs` with `text`, `url` or `base64`, MCP `print`, email to print, test pages | `queueJob` | After the document is fetched and counted, before anything is stored |
| `POST /jobs` with `upload`, a computer's print window (`POST /api/client/jobs`) | `queueJob`, then `storeUpload` | A first check when the job is created, with pages not counted yet, so most refusals come before the upload. The full check once the file is stored, before `uploading` becomes `queued` or `held` |
| Retry | `retryJob` | Before the job goes back to the queue, starting from what the sender asked for (`policy.requested`) |
| `POST /jobs/preview` | the same code | Nothing is stored or sent |

LAN sharing is never checked. Email to print checks each attachment as its own job.

### Order

1. **Printer access**: the sender needs `print` on the printer. This is the existing check, unchanged.
2. **Rules** (Print rules and limits), top to bottom.
3. **Limits** (Print rules and limits).
4. **Cost center** (Enterprise controls).
5. **Budgets** (Enterprise controls).
6. **Approval** (Enterprise controls).
7. **Release** (Enterprise controls).

Steps of an inactive extension are skipped. Each step sees the job as earlier steps left it. The usage estimate is worked out again after every step, so a limit sees the job a rule made two-sided.

### What a Check Can Do

- Change the job's options: two-sided, black and white, fewer copies.
- Send it to another printer. Only an added printer where the sender has `print`.
- Refuse it with a message. No later step runs.
- Ask for approval, or to hold it until its sender releases it. Enterprise controls turns these into status `held`. Without it, or with its approvals or secure release turned off, a rule's request is skipped and a limit or budget set to require approval blocks.
- Add notes. They end up in `policy.notes`.
- Pick the cost center.
- Carry the usage estimate and the limits and budgets it counts against.

A refusal is `403 policy_blocked` with the message, wherever the job came from. Email to print uses it as the rejection reason, and a computer's print queue shows it. Nothing is stored for an inline document. An upload refused when its file arrives has its file deleted and becomes `canceled` with the message. A refused retry stays as it was. Every refusal is audited as `job.block`.

Side effects (alert emails, approval emails, the `approval` event) run after the job is stored, never for previews or refusals.

## Page Counting

The server counts pages from the stored document with `countPages` in `server/shared/pages/`. The same code runs in the browser for previews. It reads only the parts it needs through a `ByteSource`: R2 range reads, a buffer, or a browser `File`.

- **PDF**: the end of the file gives `startxref`, then the cross-reference section (a table, or a compressed xref stream), the catalog, and the page tree's `/Count`. Object streams and xref streams are inflated with `DecompressionStream`. `/Prev` chains from incremental updates are followed. If that fails, a bounded scan looks for the page tree root (`/Type /Pages` without `/Parent`). At most about 20 reads and 8 MB inflated per document, so CPU stays low.
- **JPEG and PNG**: 1 page.
- **Text**: laid out like the client's converter (`client/crates/print/src/convert/text.rs`): Courier 10 pt at 6 pt per character, 12 pt lines, 36 pt margins, word wrap, tabs every 8 columns, and a form feed starts a page. Paper comes from `options.media`, else the printer's `mediaDefault`, else US Letter. Landscape swaps the sides.
- **A computer's print window**: the system print queue converts to PDF (the `pb_` queues accept PDF, JPEG and PNG), counted like any PDF. Quartz PDFs from macOS have a plain cross-reference table, the cheapest case. Output from Linux applications may use object streams.
- **Can't count** (broken files, encrypted files with object streams): the job counts as 1 page per copy and `usage.documentPages` is null. What the printer reports corrects it later.

From the count:

- Selected pages: pages within `pageRanges`.
- Printed pages: selected pages times copies.
- Sheets: selected pages, halved and rounded up when two-sided, times copies.
- Color pages: the printed pages when the job prints in color (it asks for color, or for automatic on a color printer), else 0.

Options are the job's own over the printer's defaults, as the device applies them.

**Trust.** The server never trusts a count from whoever sends the job, since a modified client could send any number. `documentPages` in `POST /jobs/preview` is used for that preview only. The device that owns the printer is trusted for what printed: an admin paired it, and it already reports the job's status.

## Usage

`usage_entries` has one row per job attempt: member, device, printer, cost center, source, and jobs, pages, sheets, color pages, and cost.

- It is written with the estimate when the attempt is queued or held, and counts against limits and budgets right away.
- When the attempt ends, it is settled. A completed job counts the pages the device reported, or the estimate when it reported none. A failed or canceled job counts the reported pages or 0, and 0 jobs. When the reported pages differ from the estimate, sheets and cost are worked out again from them, at the prices of that moment. The job's `usage` follows, with `estimated: false`.
- When the attempt was queued decides its cycle.
- A retry is a new attempt and a new row.
- The cron settles rows that are still estimates when their job has ended or is gone.
- Rows have no foreign key to jobs, so usage outlives deleted jobs. Removing a printer, a device, or a member's account keeps the row and clears that link.

Printers report differently. Some count sheets instead of printed sides, some leave copies out. When a printer reports nothing, the estimate stays. Jobs checked at the same moment can go over a limit by the size of the jobs in flight.

## Cycles

Day, week (choose the first day), month (starts on day 1 to 28), quarter, and year (choose the start month; quarters start every 3 months from it). Boundaries are local midnights in the workspace time zone, computed with `Intl.DateTimeFormat` (`hourCycle: 'h23'`):

1. Format now in the zone to get today's local date.
2. Find the cycle's first local date with calendar arithmetic on year, month, and day.
3. Take the UTC midnight of that date, subtract the zone's offset there, then check the offset at the result and correct once if it differs.

A cycle ends at the next one's first midnight. On DST change days a day lasts 23 or 25 hours, and boundaries never drift because each is computed from a local date. Where a zone skips midnight (some change clocks at 00:00), the day starts when the clock jumps, at 01:00. Where midnight repeats, the first one counts.

## Prices

- A currency (ISO 4217, default USD) and a time zone (IANA, default UTC).
- A default price list, which each printer can override: per black-and-white page, per color page, and a discount per sheet printed on both sides.
- Cost is printed pages times the page price, minus the discount for each sheet printed on both sides, never below 0.
- Money is in micros, integer millionths of the currency: 0.025 is `25000`. Sums are exact.

Members can read prices, with only the printer prices of printers they can see. Admins change them under **Workspace settings > Prices** while either extension is active.

## API

All under `/api/workspaces/:ws`. These answer `404 extension_inactive` while both extensions are off. Types are in `server/shared/usage.ts`.

| Method and path | Who | What |
|---|---|---|
| `POST /jobs/preview` | members with `print` on the printer | `JobPreviewRequest` returns `JobPreview`: the refusal, if any, the changed printer and options, notes, hold, cost center, usage, and the limits and budgets it counts against |
| `GET /prices` | members | `Prices` |
| `PUT /prices` | admins | `PricesUpdate` returns `Prices`; `400` for an unknown currency, time zone, or printer |

`Job` fields:

| Field | Written by | Content |
|---|---|---|
| `policy` | either | `{ notes, requested? }`: what checked or changed the job, and what the sender asked for when a rule changed it |
| `held` | Enterprise controls | `{ kind, until, reasons? }`, present exactly while `status` is `held` |
| `costCenterId` | Enterprise controls | The cost center charged |
| `usage` | either | `{ documentPages, pages, sheets, colorPages, costMicros, estimated }` |

Errors: `403 policy_blocked`. Audit: `prices.update`, `job.block`. Browser events: `usage` after usage is recorded or settled and after prices change.

MCP: `get_prices`, `set_prices`, and `preview_print_job`, listed while either extension is available on the instance.

## For Developers

Hook interfaces and registries are in `server/worker/extensions/hooks.ts`. The foundation's code lives in `server/worker/extensions/usage/` and `server/shared/pages/`.

| Registry | Called from | Used for |
|---|---|---|
| `JOB_STEPS` | the job check, run by `queueJob`, `storeUpload`, `retryJob`, and the preview | The steps above, in `JobStepName` order |
| `JOB_FINISH_HOOKS` | every place a job ends: `applyJobStatus` (hub), `cancelOwnedJob`, `failStaleJobs` (cron), `deletePrinter`, `deleteClient`, a refused upload in `storeUpload`, and Enterprise controls' own cancels | Settling usage, then retention |
| `JOB_VIEW_HOOKS` | job responses (REST and MCP), browser events, emails | Hiding document names |
| `EXTENSION_OFF_HOOKS` | `patchWorkspaceExtension` and `patchInstanceExtension`, whenever an extension stops applying | Canceling held jobs |
| `CRON_HOOKS` | `runCron` | Settlement sweep, held job expiry, scheduled reports |
| `EXTENSION_TOOL_ARGUMENTS` (in `extensions/tools.ts`) | MCP `tools/list` and `tools/call` | `costCenter` on `print`, `held` in `list_jobs`, while Enterprise controls is available |

`queueJob` callers pass the sender's `Access` and role, and the raw `costCenter` from the request body. The core only passes it on. Shared tools and routes are listed under both extensions without duplicates.

Tables, every row cascading on workspace delete:

- `0007_held_jobs.sql`: `jobs` rebuilt with status `held` and the columns `policy`, `held`, `usage`, `cost_center_id`. Nothing may reference `jobs`, so it can be rebuilt again.
- `0008_usage.sql`: `usage_settings` (currency, time zone, default prices), `printer_prices`, `usage_entries`.
- `0009_print_policies.sql`: `print_rules`, `print_limits`, `limit_adjustments`.
- `0010_enterprise.sql`: `cost_centers`, `cost_center_defaults`, `budgets`, `printer_controls`, `report_schedules`, `usage_alerts`. Enterprise settings live in `workspace_extensions.config`.

### Held Jobs in the Core

- Devices are offered only `queued` jobs (`hub.dispatch`, `pendingOffers`, `stuckOffers`), and `failStaleJobs` names the statuses it fails, so held jobs are never sent or failed as stuck. Their expiry runs from `CRON_HOOKS`.
- `held` outranks every device report in `applyJobStatus`, so a late report can't move a held job.
- `cancelOwnedJob` cancels held jobs on the spot, and `deletePrinter` cancels them with the printer's other open jobs. Leaving `held` clears `jobs.held`.
- `GET /jobs?status=held` is accepted only while Enterprise controls is active; otherwise the error stays as it is today.

### Client

- `not_sent` in `client/crates/app/src/daemon/remote/sink.rs` shows a `403 policy_blocked` message as it is, like `printer_access_denied`.
- `ipp_state` in `api.rs` treats `held` as the end of the local job: completed, with the server's message. The CUPS queue sends one job at a time, so a local job that waited would hold back every job behind it.

### Web App

`server/src/extensions/` gains two things. `ExtensionUi` takes the id `usage`, active while either extension is. `ExtensionUi.pages` adds routes under `/w/:ws`, each with an optional nav entry and a `visible` rule.

| What | Registered by | Slot or route |
|---|---|---|
| Prices, currency, time zone | `usage` | `settingsTab` (**Prices**) |
| Print dialog: what will happen, what is left | `usage` | `printForm` (new; it may add fields such as `costCenter` to the job request) |
| Print dialog: cost center picker | `enterprise` | `printForm` |
| Notes, pages, and cost under each job | `usage` | `jobMeta` (new) |
| The **Usage** page | `usage` | `/w/:ws/usage/:tab?`, 1 tab per `usageTab` entry (new) |
| Overview, Limits, Rules | `print-policies` | `usageTab` (Limits and Rules for admins) |
| What is left, on Home | `print-policies` | `homeSection` (new) |
| Alerts, waiting approvals, jobs ready to release, on Home | `enterprise` | `homeSection` |
| Approvals | `enterprise` | `jobsTab` (new, on Print jobs, for approvers) and `jobActions` (new) |
| Ready to release | `enterprise` | `jobsTab` (while secure release is on) and `jobActions` |
| Cost centers, defaults, and budgets | `enterprise` | `usageTab` (admins) |
| Reports, schedules, and the audit export | `enterprise` | `usageTab` (admins) |
| Enterprise settings | `enterprise` | `settingsTab` |
| A printer's approval and release switches | `enterprise` | `printerTab` (`settings` on the printer) and `printerBadge` |
| A device's default cost center | `enterprise` | `deviceSection` |

`realtime.ts` refetches usage on `usage` events and shows approvers a notice on `approval` events.

An extension's `useFeatures` hook names its parts that are on (`enterprise.approvals` and so on) in `SlotContext.features`, so `visible` rules can hide entries for parts that are off.
