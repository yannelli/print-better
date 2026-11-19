# Enterprise controls

**Enterprise controls** (`enterprise`) is an [extension](extensions.md) for organizations that need oversight of printing: **approvals**, **secure release**, **cost centers and budgets**, **reports**, **alerts**, and stricter **retention and privacy**. It is off by default, and each part has its own switch inside the extension, also off until you turn it on.

Turn it on in two steps: a server admin makes it available under **Admin > Extensions**, then a workspace owner enables it under **Workspace settings > Extensions**. **Turning it on changes nothing by itself.**

It works on its own and does more alongside other extensions:

- With [Print rules and limits](print-policies.md): rules and limits can require approval or hold jobs for release, alerts cover limits, and reports show limits.
- With [Printer access](printer-access.md): people with `jobs.manage` on a printer can approve its jobs, and cost centers can be assigned to groups.

Page counting, usage, cycles, and prices are shared with Print rules and limits. See [Usage and job checks](usage.md).

## Approvals

A job that needs approval waits with the status **held** (`held.kind` is `approval`) instead of printing. Its message says "Waiting for approval", and `held.reasons` says why.

- **What sends a job for approval:** a printer set to **Every job needs approval**, a budget set to require approval when reached, and (with Print rules and limits) a rule with **Require approval** or a limit set to require approval when reached.
- **Who approves:** workspace owners and admins, and with Printer access anyone with `jobs.manage` on the printer. Approvers can't approve their own jobs, except owners and admins. Approvers see the **Approvals** tab on Print jobs, get a live notice in the web app, and get an email when outbound email is set up.
- **Approve** prints the job, or holds it for release next when the printer or a rule asks for that. **Deny** cancels it with the approver's reason, which the person who printed sees as "Not approved: reason".
- Unanswered requests **expire** after a workspace setting (default 24 hours) and are canceled with "Not approved in time".
- AI assistants and the API approve and deny through the same rules.

## Secure release

A printer set to **Hold jobs until released**, or a rule with **Hold for release**, keeps each job **held** (`held.kind` is `release`, message "Waiting to be released at the printer") until the person who sent it releases it, typically from their phone while standing at the printer.

- The **Release** page lists the caller's own held jobs, with one large button per job and a **Release all**. It works on phones.
- Only the sender, owners, and admins can release a held job. Others see it like any other job they can see, with names following the privacy settings.
- Held jobs expire after a workspace setting (default 4 hours) and are canceled with "Not released in time". Their documents are deleted then.
- A job from a computer's print window has no member, so only owners and admins can release it.

## Jobs from a computer's print window

The computer's print queue hands each job to Print Better and follows it. When the server holds a job, the computer ends its copy of the job with the hold message, for example "Waiting for approval", so the jobs behind it in that queue are sent too. The held job is then managed in the web app. A refused job fails in the print queue with the rule's, limit's, or budget's message.

## Cost centers and budgets

Cost centers (departments, projects, clients) let you charge printing to the right place.

- Each cost center has a name, an optional code, and an active switch. Inactive ones can't be chosen but keep their history. A cost center can be deleted only until a job is charged to it.
- **Defaults:** each member, each group (with Printer access), and each device can have a default cost center.
- **Which one a job uses:** the one the sender picked, else the member's default, else the default of the member's groups (first by name), else the device's. For uploads, this is settled when the job is created.
- **Choosing:** the print dialog asks which cost center to charge, pre-filled with the default. The REST API and MCP take a `costCenter` field (an id or a code) next to `printerId`. A cost center that doesn't exist or is inactive is refused with `400 cost_center_invalid`.
- **Every job needs a cost center** (a workspace setting) refuses jobs without one. Test pages are never refused for this.
- **Budgets:** a cost center can have budgets per cycle (the same cycles as limits), counted in cost or pages, covering every job charged to it. When reached: block, warn and allow, or require approval.

## Reports

Usage by **member, group, device, printer, cost center, or source**, for any range of dates in the workspace time zone: jobs, pages, sheets, color pages, and cost, with totals and a per-day chart. A member in two groups counts in both. Reports never show document names.

- **Export** any report as CSV: UTF-8, a header row (`name`, `key`, `jobs`, `pages`, `sheets`, `colorPages`, `cost`), quoted as RFC 4180, cost as a decimal in the workspace currency.
- **Scheduled reports:** weekly or monthly, emailed to chosen members as a summary with the CSV attached, when outbound email is set up.
- **Audit export:** the workspace audit log as CSV, for a date range (owners and admins), with `time` (ISO 8601, UTC), `actorType`, `actorId`, `actorName`, `action`, `target`, and `data` (JSON).

## Alerts

- An email at **80%** and at **100%** of any limit or budget, to the person a personal limit counts (each member, a member, or each member of a group) and to the workspace's admins. Budget alerts go to the admins only. Each alert is sent at most once per threshold, per count, per cycle.
- The person also sees a banner on their home page while they are at or over 80%.
- Admins choose whether personal and admin alerts are sent, and who receives admin alerts (default: every owner and admin).

## Retention and privacy

- **Delete documents as soon as a job finishes**, overriding the workspace's keep-documents time. Retry is then unavailable for finished jobs.
- **Show document names only to the person who printed them.** Everyone else, including in events, emails, the API, and MCP, sees the title "Document" and no file name. Owners and admins see names only if **Admins can see document names** is on. The computer that sent a job sees its names.
- Only owners change these settings.

## Emails

Sent with the existing outbound email (`sendMail` in `server/worker/email/outbound.ts`, through Resend or the Cloudflare email binding), only when it is set up. Templates go in `email/templates.ts`. `Mail` gains `attachments?: { filename, contentType, content }[]` with text content: Resend gets it base64 encoded, and the Cloudflare binding gets `{ disposition: 'attachment', filename, type, content }`. Links use the origin of the request that caused the email, or the one saved with a report schedule. Document names follow the privacy settings.

| Email | To | When |
|---|---|---|
| Approval request | Each approver of the job with an email address | When a job starts waiting for approval: who, what, which printer, why, and until when, with a link to Approvals |
| Usage alert | The person and the admin recipients | When recorded or reported usage crosses 80% or 100% |
| Scheduled report | The schedule's members | At 08:00 local on the first day of each week or month, covering the one that ended; totals and top rows in the text, every row in the attached CSV |

## Turning it off

Everything stops applying immediately. Jobs waiting for approval or release are **canceled** with "Enterprise controls were turned off", so nothing prints without the checks that held it. This happens for either switch, and the cron catches any job held at the same moment. Turning off approvals or secure release alone cancels the jobs waiting for it the same way. Settings, cost centers, budgets, and history are kept.

## In the web app

- **Print jobs**: an **Approvals** tab for approvers, with Approve and Deny beside each waiting job.
- **Release**: a page in the navigation while secure release is on.
- **Cost centers** (admins): cost centers, defaults, and budgets.
- **Reports** (admins): usage, scheduled reports, and the audit export.
- **Workspace settings**: each part's switch and settings. **Printer** pages: approval and release switches, and badges on printers that use them.
- **Print dialog**: the cost center picker. **Home**: alerts, jobs waiting for your approval, and your jobs ready to release.

## API

All under `/api/workspaces/:ws`. Routes answer `404 extension_inactive` while it is off, and `409 part_off` while their part is off. Types are in `server/shared/enterprise.ts`.

| Method and path | Who | What |
|---|---|---|
| `GET /enterprise` | members | `EnterpriseConfig`: each part's settings, and printers with controls |
| `PATCH /enterprise` | admins; owners for `privacy` | `EnterpriseSettingsUpdate` returns `EnterpriseConfig` |
| `PATCH /printers/:id/enterprise` | admins, or `settings` on the printer | `{ "approval"?, "secureRelease"? }` returns `PrinterControls` |
| `GET /approvals` | approvers | `Job[]` waiting for approval that the caller may approve, oldest first |
| `POST /jobs/:id/approve`, `POST /jobs/:id/deny` | approvers | `{ "note"? }` / `{ "reason" }`, returns `Job` |
| `GET /release` | members | `Job[]`: the caller's jobs ready to release; owners and admins add `?everyone=true` |
| `POST /jobs/:id/release` | the sender, owners and admins | Returns `Job` |
| `POST /release/all` | members | `{ "released": Job[] }`, the caller's own |
| `GET /cost-centers`, `POST /cost-centers` | members read, admins write | `CostCenterList`; create with `CostCenterInput` |
| `PATCH /cost-centers/:id`, `DELETE /cost-centers/:id` | admins | Edit; delete only until it was used (`409 cost_center_in_use`, deactivate it instead) |
| `GET /cost-centers/defaults`, `PUT /cost-centers/defaults` | admins | `CostCenterDefaults`; `PUT` merges, null removes a default |
| `GET /budgets`, `POST /budgets`, `PATCH /budgets/:id`, `DELETE /budgets/:id` | admins | `BudgetView[]` with this cycle's usage; `BudgetInput` |
| `GET /reports/usage?by=&from=&to=` | admins | `UsageReport`; `format=csv` for CSV |
| `GET /reports/schedules`, `POST /reports/schedules`, `DELETE /reports/schedules/:id` | admins | `ReportSchedule[]`; create with `ReportScheduleInput` |
| `GET /audit/export?from=&to=` | owners and admins | Audit log CSV |

While it is active, core routes also take: `costCenter` in `POST /jobs`, `status=held` in `GET /jobs`, and the same in MCP `print` and `list_jobs`. Jobs gain `held` and `costCenterId` (see [Job fields](usage.md#api)).

Errors: `403 policy_blocked` (a budget or the required cost center refused the job), `400 cost_center_invalid`, `409 cost_center_in_use`, `409 job_not_held` (approving, denying, or releasing a job that isn't waiting for that), `409 part_off`, `409 name_taken` (a cost center name or code in use), and `403 forbidden` for someone who may not approve or release the job.

Every change is audited: `enterprise.update`, `enterprise.printer`, `approval.request`, `approval.approve`, `approval.deny`, `approval.expire`, `release.release`, `release.expire`, `cost_center.create`, `cost_center.update`, `cost_center.delete`, `cost_center.defaults`, `budget.create`, `budget.update`, `budget.delete`, `report.schedule_create`, `report.schedule_delete`, `report.send`, `report.export`, `audit.export`. Jobs canceled by turning it off are audited as `job.cancel`.

Events: `approval` when a job starts waiting for approval, `job` for every hold and release, `usage` for budget changes, and `access` after settings change, so open pages refetch.

## MCP

Listed when the extension is available on the instance: `list_approvals`, `approve_job`, `deny_job`, `list_ready_to_release`, `release_job`, `list_cost_centers`, `create_cost_center`, `update_cost_center`, `delete_cost_center`, `set_cost_center_defaults`, `list_budgets`, `create_budget`, `update_budget`, `delete_budget`, `usage_report`, `get_enterprise_settings`, `update_enterprise_settings`, `set_printer_controls`, and the shared `get_prices`, `set_prices`, `preview_print_job`. While it is available, `print` also takes `costCenter` and `list_jobs` takes `status: held`.
