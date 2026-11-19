# Enterprise Controls

**Enterprise controls** (`enterprise`) is an [extension](extensions.md) for organizations that need oversight of printing: **approvals**, **secure release**, **cost centers and budgets**, **reports**, **alerts**, and stricter **retention and privacy**. It is off by default, and each part has its own switch inside the extension, also off until you turn it on.

## Turning It On

1. A server admin opens **Server admin > Extensions** and turns on **Available to workspaces** for **Enterprise controls**.
2. A workspace owner opens **Workspace settings > Extensions**, turns on **Enterprise controls**, and clicks **Turn on** to confirm. An **Enterprise** tab appears in **Workspace settings**.
3. An admin turns on the parts they want on that tab.

Turning it on changes nothing by itself, and neither does turning on a part until something uses it (a printer switch, a budget, a rule).

It works alone and does more alongside other extensions:

- With [Print rules and limits](print-policies.md): rules and limits can require approval or hold jobs for release, and alerts cover limits.
- With [Printer access](printer-access.md): people with `jobs.manage` on a printer can approve its jobs, and groups can have a default cost center.

Page counting, usage, cycles, and prices are shared with Print rules and limits. See [Usage and job checks](usage.md).

## Approvals

A job that needs approval waits with the status `held` (`held.kind` is `approval`). Its message is "Waiting for approval", and `held.reasons` says why.

- **What sends a job for approval:** a printer set to **Every job needs approval**, a budget set to **Require approval**, and (with Print rules and limits) a rule or limit that requires approval.
- **Who approves:** owners and admins, and with Printer access anyone with `jobs.manage` on the printer. Only owners and admins can approve their own jobs. Approvers see **Print jobs > Approvals**, get a live notice in the web app, and get an email when outbound email is set up.
- **Approve** prints the job, or holds it for release next when the printer or a rule asks for that. **Deny** cancels it with the approver's reason, shown to the sender as "Not approved: reason".
- Unanswered requests expire after **Cancel unanswered requests after** (1 to 168 hours, default 24) and are canceled with "Not approved in time".
- AI assistants and the API approve and deny through the same rules.

## Secure Release

A printer set to **Hold jobs until released**, or a rule that holds jobs for release, keeps each job `held` (`held.kind` is `release`, message "Waiting to be released at the printer") until its sender releases it, usually from their phone at the printer.

- **Print jobs > Ready to release** lists the caller's held jobs with a large **Release** button each and **Release all**. Owners and admins can switch to everyone's jobs.
- Only the sender, owners, and admins can release a job. A job from a computer's print window has no member, so only owners and admins can release it.
- Held jobs expire after **Cancel unreleased jobs after** (1 to 72 hours, default 4) and are canceled with "Not released in time". Their documents are deleted then.

## Jobs from a Computer's Print Window

The computer's print queue hands each job to Print Better and follows it. When the server holds a job, the computer ends its copy with the hold message, for example "Waiting for approval", so the jobs behind it in that queue go out too. The held job is then managed in the web app. A refused job fails in the print queue with the rule's, limit's, or budget's message.

## Cost Centers and Budgets

Cost centers (departments, projects, clients) charge printing to the right place.

- Each one has a name, an optional code, and an active switch. Inactive ones can't be chosen and keep their history. A cost center can be deleted only until a job or usage is charged to it.
- **Defaults:** each member, each group (with Printer access), and each device can have a default cost center.
- **Which one a job uses:** the one the sender picked, else the member's default, else the default of the sender's groups (first by name), else the device's. For uploads it is settled when the job is created.
- **Choosing:** the print dialog asks **Charge to**, starting at the default. The REST API and MCP take `costCenter` (an id or a code) next to `printerId`. A cost center that doesn't exist or is inactive is refused with `400 cost_center_invalid`.
- **Every job needs a cost center** refuses jobs without one. Test pages always print.
- **Budgets:** a cost center can have budgets per cycle (the same cycles as limits), counted in cost or pages, covering every job charged to it. When a job would go over: block, warn and allow, or require approval. Require approval blocks while approvals are off.

## Reports

Usage by **member, group, device, printer, cost center, or source** for any range of up to 366 dates in the workspace time zone: jobs, pages, sheets, color pages, and cost, with totals and a per-day chart. A member in 2 groups counts in both. Reports never show document names.

- **Export** any report as CSV: UTF-8, a header row (`name`, `key`, `jobs`, `pages`, `sheets`, `colorPages`, `cost`), quoted as RFC 4180, cost as a decimal in the workspace currency.
- **Scheduled reports:** weekly or monthly, emailed to chosen members with the totals and top rows in the text and every row in an attached CSV, when outbound email is set up.
- **Audit export:** the workspace audit log as CSV for a range of dates, with `time` (ISO 8601, UTC), `actorType`, `actorId`, `actorName`, `action`, `target`, and `data` (JSON).

## Alerts

- An email at **80%** and at **100%** of a limit or budget. A limit that counts one person (each member, a member, or each member of a group) emails that person, and every limit and budget emails the admin recipients. Each alert goes out at most once per threshold, per count, per cycle.
- Counts are checked when a job is queued, with its estimate, and again when its printer reports what it printed.
- While personal alerts are on, people also see an alert on Home when they are at or over 80% of a limit.
- Admins choose whether personal and admin alerts go out, and who gets admin alerts (default: every owner and admin).

## Retention and Privacy

Only owners change these.

- **Delete documents as soon as a job finishes**, overriding the workspace's keep-documents time. Finished jobs can't be retried then.
- **Show document names only to the person who printed them.** Everyone else, including in events, emails, the API, and MCP, sees the title "Document" and no file name. Their downloads are named `document.pdf`, `document.txt` and so on, and the computer that prints the job gets the title "Document" too. Owners and admins see names only if **Owners and admins can see document names** is on. The computer that sent a job sees its names.

## Emails

Sent with the existing outbound email (`sendMail` in `server/worker/email/outbound.ts`, through Resend or the Cloudflare email binding), only when it is set up. Templates are in `email/templates.ts`. `Mail` has `attachments?: { filename, contentType, content }[]` with text content: Resend gets it base64 encoded, and the Cloudflare binding gets `{ disposition: 'attachment', filename, type, content }`. Links use the origin of the request that caused the email, or the one saved with a report schedule. Document names follow the privacy settings.

| Email | To | When |
|---|---|---|
| Approval request | Each approver of the job with an email address | A job starts waiting for approval: who, what, which printer, why, and until when, with a link to Approvals |
| Usage alert | The person and the admin recipients | Recorded or reported usage crosses 80% or 100% |
| Scheduled report | The schedule's members | 08:00 local on the first day of each week or month, covering the one that ended |

## Turning It Off

Everything stops applying right away. Jobs waiting for approval or release are canceled with "Enterprise controls were turned off", so nothing prints without the checks that held it. This happens for either switch, and the cron catches any job held at the same moment. Turning off **Approvals** or **Secure release** alone cancels the jobs waiting for it with "Approvals were turned off" or "Secure release was turned off". Settings, cost centers, budgets, and history are kept.

## In the Web App

Each place shows only while its part is on.

| Where | What |
|---|---|
| **Workspace settings > Enterprise** | One part at a time, each with its switch and settings. Members can look; admins change; only owners change retention and privacy. `#approvals`, `#alerts` and so on open a part. |
| **Print jobs** | **Approvals** for approvers and **Ready to release** for everyone, as tabs next to **All jobs**. Held jobs in the list get **Approve** and **Deny**, or **Release**, and show the cost center they're charged to. |
| **Usage** (admins) | **Cost centers** (with defaults), **Budgets**, and **Reports** (with scheduled reports and the audit export) tabs. |
| A printer's page | An **Approval and release** tab for people with `settings` on it, and **Needs approval** or **Release at printer** badges wherever the printer shows. |
| Print dialog | **Charge to**, the cost center picker. |
| A device's page (admins) | **Cost center**: the device's default. |
| **Home** | A limit alert, the jobs waiting for your approval, and your jobs ready to release with **Release all**. |

## API

All under `/api/workspaces/:ws`. Routes answer `404 extension_inactive` while the extension is off, and `409 part_off` while their part is off. Types are in `server/shared/enterprise.ts`.

| Method and path | Who | What |
|---|---|---|
| `GET /enterprise` | members | `EnterpriseConfig`: each part's settings, and printers with controls |
| `PATCH /enterprise` | admins; owners for `privacy` | `EnterpriseSettingsUpdate` returns `EnterpriseConfig` |
| `PATCH /printers/:id/enterprise` | admins, or `settings` on the printer | `{ "approval"?, "secureRelease"? }` returns `PrinterControls` |
| `GET /approvals` | approvers | `Job[]` waiting for approval that the caller may approve, oldest first |
| `POST /jobs/:id/approve`, `POST /jobs/:id/deny` | approvers | `{ "note"? }` / `{ "reason" }`, returns `Job` |
| `GET /release` | members | `Job[]`: the caller's jobs ready to release; owners and admins add `?everyone=true` |
| `POST /jobs/:id/release` | the sender, owners, and admins | Returns `Job` |
| `POST /release/all` | members | `{ "released": Job[] }`, the caller's own |
| `GET /cost-centers`, `POST /cost-centers` | members read, admins write | `CostCenterList`; create with `CostCenterInput` |
| `PATCH /cost-centers/:id`, `DELETE /cost-centers/:id` | admins | Edit; delete only until it was used (`409 cost_center_in_use`, deactivate it instead) |
| `GET /cost-centers/defaults`, `PUT /cost-centers/defaults` | admins | `CostCenterDefaults`; `PUT` merges, null removes a default |
| `GET /budgets`, `POST /budgets`, `PATCH /budgets/:id`, `DELETE /budgets/:id` | admins | `BudgetView[]` with this cycle's usage; `BudgetInput` |
| `GET /reports/usage?by=&from=&to=` | admins | `UsageReport`; `format=csv` for CSV |
| `GET /reports/schedules`, `POST /reports/schedules`, `DELETE /reports/schedules/:id` | admins | `ReportSchedule[]`; create with `ReportScheduleInput` |
| `GET /audit/export?from=&to=` | owners and admins | Audit log CSV |

While it is active, core routes also take `costCenter` in `POST /jobs` and `status=held` in `GET /jobs`, and MCP `print` and `list_jobs` take the same. Jobs gain `held` and `costCenterId` (see [Job fields](usage.md#api)).

Errors: `403 policy_blocked` (a budget or the required cost center refused the job), `400 cost_center_invalid`, `409 cost_center_in_use`, `409 job_not_held` (approving, denying, or releasing a job that isn't waiting for that), `409 part_off`, `409 name_taken` (a cost center name or code in use), and `403 forbidden` for someone who may not approve or release the job.

Every change is audited: `enterprise.update`, `enterprise.printer`, `approval.request`, `approval.approve`, `approval.deny`, `approval.expire`, `release.release`, `release.expire`, `cost_center.create`, `cost_center.update`, `cost_center.delete`, `cost_center.defaults`, `budget.create`, `budget.update`, `budget.delete`, `report.schedule_create`, `report.schedule_delete`, `report.send`, `report.export`, `audit.export`. Jobs canceled by turning it or a part off are audited as `job.cancel`.

Events: `approval` when a job starts waiting for approval, `job` for every hold and release, `usage` for budget changes, and `access` after settings change, so open pages refetch.

## MCP

Listed when the extension is available on the instance: `list_approvals`, `approve_job`, `deny_job`, `list_ready_to_release`, `release_job`, `list_cost_centers`, `create_cost_center`, `update_cost_center`, `delete_cost_center`, `set_cost_center_defaults`, `list_budgets`, `create_budget`, `update_budget`, `delete_budget`, `usage_report`, `get_enterprise_settings`, `update_enterprise_settings`, `set_printer_controls`, and the shared `get_prices`, `set_prices`, and `preview_print_job`. While it is available, `print` and `preview_print_job` also take `costCenter`, and `list_jobs` takes `status: held`.
