# Print Rules and Limits

**Print rules and limits** (`print-policies`) is an [extension](extensions.md) that checks every print job before it is queued: **rules** can change, redirect, or stop a job, and **limits** cap how much people, groups, devices, and printers print in each cycle. It is off by default.

Turn it on in 2 steps: a server admin makes it available under **Server admin > Extensions**, then a workspace owner turns it on under **Workspace settings > Extensions**. **Turning it on changes nothing by itself**: there are no rules or limits until you add them.

It works on its own and does more alongside other extensions:

- With [Printer access](printer-access.md): rules and limits can target groups, and "Send to another printer" only picks printers the person may print to.
- With [Enterprise controls](enterprise.md): rules and limits can require approval or hold jobs for release, alerts warn at 80% and 100% of a limit, and reports include limits.

Page counting, usage, cycles, and prices are shared with Enterprise controls. See [Usage and job checks](usage.md).

## Where It Applies

Every job, wherever it comes from: the web app, the REST API, AI assistants (MCP), email to print, a computer's print window (remote printers), and test pages. Each job is checked after printer access allows it and before it is queued (see [The Job Check](usage.md#the-job-check)). Jobs already printing are never stopped. LAN sharing is outside it, like printer access.

Rules and limits apply to owners and admins too, unless a rule or limit is set to **Doesn't apply to owners and admins**.

## Rules

A rule has a name, an on/off switch, **conditions**, and **actions**. Rules run **top to bottom**, in the order shown under **Usage > Rules**. Every rule whose conditions all match applies its actions, and later rules see the job as earlier rules left it. A rule that **blocks** stops the job right away.

### Conditions

All conditions in a rule must match. A rule without conditions matches every job.

| Condition | Key in `conditions` | Matches when |
|---|---|---|
| Who | `who` | The job is from one of these members, groups (needs Printer access), or devices. Leave it out for everyone |
| Source | `sources` | It came from the web app, API, AI assistant, email, a computer's print window, or a test page |
| Printer | `printers` | It goes to one of the chosen printers |
| Pages | `pages` | Its total pages (pages in the chosen range, times copies) are at least `min`, at most `max`, or between the two |
| Copies | `minCopies` | It asks for at least this many copies |
| Color | `color` | It would print in color (it asks for color, or for automatic on a color printer) |
| Sides | `sides` | It asks for one-sided or two-sided printing |
| File type | `fileKinds` | It is a PDF, an image, or text |
| File size | `minSizeMb` | Its file is at least this many megabytes |
| Time | `time` | It is sent on the chosen days, between `from` and `to`, in the workspace time zone. A `to` earlier than `from` crosses midnight |

Pages that couldn't be counted count as 1 page per copy.

### Actions

| Action | `type` | Effect |
|---|---|---|
| Block | `block` | The job is refused with your message, shown wherever it was sent from |
| Print two-sided | `two-sided` | Two-sided, long edge, when the printer can |
| Print in black and white | `monochrome` | Black and white |
| Limit copies | `max-copies` | At most this many copies |
| Send to another printer | `redirect` | Moves the job to another added printer. With Printer access, only if the sender may print there; otherwise the action is skipped with a note |
| Require approval | `approval` | Waits for an approver. Needs Enterprise controls with approvals on; skipped otherwise |
| Hold for release | `release` | Waits until the sender releases it. Needs Enterprise controls with secure release on; skipped otherwise |
| Add a note | `note` | Shows your note on the job, for example "Printed two-sided to save paper" |

Everything a rule changed is recorded on the job in `policy.notes` and shown under it in **Print jobs**, for example "Big jobs on both sides: Printed two-sided". What the sender asked for is kept in `policy.requested`. The web print dialog shows the outcome before you send, using `POST /jobs/preview`.

## Limits

A limit has a name, **who** it applies to, **what it counts**, an **amount**, a **cycle**, and **what happens when it is reached**.

| Setting | Choices |
|---|---|
| Who (`scope`) | Each member (`each-member`); a member (`member`); a group, sharing one count (`group`) or with a count for each member and device (`group-each`), both needing Printer access; each device (`each-device`); a device (`device`); a printer (`printer`); the whole workspace (`workspace`) |
| Counts (`unit`) | Pages (printed sides, times copies), sheets of paper, jobs, or cost (see [Prices](usage.md#prices)) |
| Cycle | Every day, week (choose the first day), month (choose the day it starts, 1 to 28), quarter, or year (choose the month). Cycles reset at midnight in the workspace time zone |
| When reached (`action`) | Block (default), warn and allow, or require approval. Require approval needs Enterprise controls with approvals on; otherwise the limit blocks |

A limit set to **Doesn't apply to owners and admins** never blocks, warns about, or holds their jobs. What they print still counts toward shared counts, such as a printer's or the workspace's.

### How Usage Is Counted

1. When a job is sent, its usage is **estimated**: PDFs are counted page by page, images count as one page, and text is laid out the way the device prints it. Page ranges, copies, and two-sided printing are applied.
2. The estimate counts against every matching limit right away, together with everything already printed or waiting in the current cycle. A job that would go over a limit gets that limit's action.
3. When the job ends, the estimate is replaced by the pages the printer reported. A canceled or failed job counts only the pages actually printed.

Details are in [Usage and Job Checks](usage.md#usage).

### Extra Allowance and Visibility

- Admins can give a **one-off extra amount** for the current cycle, for example 100 more pages for one person this month. It is recorded and audited, and it ends with the cycle.
- Everyone sees the limits that count their jobs and what is left, on **Usage**, on **Home** and in the print dialog, for example "84 of 500 pages left this month, resets Dec 1".

## Prices

Prices turn pages into cost for cost limits, and for Enterprise controls budgets and reports. They are shared with Enterprise controls and editable while either extension is active. A job's cost is shown in its details and estimated in the print dialog. See [Prices](usage.md#prices).

## In the Web App

- **Usage** in the navigation (`/w/:ws/usage`):
  - **Overview**, for everyone: the limits that count your jobs and what each has left. Owners and admins also see every limit's counts, for this cycle or the last.
  - **Limits**, for owners and admins: add, change or delete limits, and give extra allowances, in dialogs.
  - **Rules**, for owners and admins: add, change, turn off, reorder or delete rules.
- **Home**: a card with the limit closest to running out, only while a limit counts your jobs.
- **Print dialog**: 1 line with what the job leaves you, or why it would be refused, and **What happens to this job** with the details.
- **Print jobs**: notes, pages and cost under each job.
- **Workspace settings > Prices**: currency, time zone and prices, shared with Enterprise controls.

Members see only **Overview**. The navigation shows **Usage** to members only while this extension is on.

## Turning It Off

Rules and limits stop applying immediately. Rules, limits, extra allowances, prices, and usage history are kept, so turning it back on restores them. Usage keeps being recorded while Enterprise controls is on. Jobs printed while both are off are never counted.

## API

All under `/api/workspaces/:ws`. Routes answer `404 extension_inactive` while it is off. Types are in `server/shared/policies.ts`.

| Method and path | Who | What |
|---|---|---|
| `GET /policies/rules` | admins | `PrintRule[]`, top to bottom |
| `POST /policies/rules` | admins | `PrintRuleInput` returns `PrintRule`, added at the bottom |
| `PATCH /policies/rules/:id` | admins | Any `PrintRuleInput` fields, returns `PrintRule` |
| `DELETE /policies/rules/:id` | admins | Delete |
| `PUT /policies/rules/order` | admins | `{ "ids": [...] }` with every rule, top to bottom; returns `PrintRule[]` |
| `GET /policies/limits` | admins | `PrintLimitView[]`: each limit with this cycle's usage |
| `POST /policies/limits` | admins | `PrintLimitInput` returns `PrintLimit` |
| `PATCH /policies/limits/:id`, `DELETE /policies/limits/:id` | admins | Edit, delete |
| `GET /policies/limits/:id/adjustments` | admins | `LimitAdjustment[]` for the current cycle |
| `POST /policies/limits/:id/adjustments` | admins | `LimitAdjustmentInput` returns `LimitAdjustment`. `subject` names whose count, for `each-*` and `group-each` limits |
| `GET /usage/me` | members | `MyUsage`: the limits that count the caller's jobs, with used, left, and reset time |
| `GET /usage?cycle=current` | admins | `PrintLimitView[]`; `cycle=previous` for the cycle before |

The job preview and prices are shared routes: `POST /jobs/preview`, `GET /prices`, `PUT /prices` (see [API](usage.md#api)).

Bodies are validated like job options: unknown keys are refused, and members, groups, devices, and printers named in a rule or limit must exist when it is saved. Ids that disappear later never match. Amounts are whole numbers, in micros for cost.

Errors: `403 policy_blocked` when a rule or limit refuses a job, with its message. `404 not_found` for a rule or limit of another workspace.

Every change is audited: `rule.create`, `rule.update`, `rule.delete`, `rule.reorder`, `limit.create`, `limit.update`, `limit.delete`, `limit.adjust`. Refused jobs are audited as `job.block`. Rule and limit changes and extra allowances send a `usage` event.

## MCP

Listed when the extension is available on the instance; each call fails with a clear message while it is inactive in the workspace: `list_print_rules`, `create_print_rule`, `update_print_rule`, `delete_print_rule`, `reorder_print_rules`, `list_print_limits`, `create_print_limit`, `update_print_limit`, `delete_print_limit`, `add_limit_allowance`, `get_my_usage`, `get_usage`, and the shared `get_prices`, `set_prices`, `preview_print_job`. Printing through MCP is checked like any other job, and a refused job returns the rule's or limit's message.
