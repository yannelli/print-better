import type { UsageReport } from '../../../shared/enterprise'
import { sendMail } from '../../email/outbound'
import { scheduledReportMail } from '../../email/templates'
import { all, first, run } from '../../lib/db'
import { audit } from '../../services/audit'
import { systemCtx, type Ctx } from '../../services/context'
import { appName, loadInstance, outboundEnabled } from '../../services/instance-store'
import { extensionActive } from '../state'
import { loadUsageSettings } from '../usage/settings'
import { amountText } from './alerts'
import { usageReport, reportCsv, reportFilename } from './reports'
import { coveredBy, nextRun, toSchedule, type ScheduleRow } from './schedules'
import { EXTENSION, loadSettings } from './store'

const TOP_ROWS = 10

const line = (name: string, t: UsageReport['totals'], currency: string) =>
  `${name}: ${t.jobs} ${t.jobs === 1 ? 'job' : 'jobs'}, ${t.pages} pages, ${t.sheets} sheets, ${t.colorPages} in color, ${amountText('cost', t.costMicros, currency)}`

function summary(report: UsageReport): string[] {
  const top = report.rows.slice(0, TOP_ROWS).map((r) => `- ${line(r.name, r, report.currency)}`)
  const more = report.rows.length > TOP_ROWS ? [`- and ${report.rows.length - TOP_ROWS} more`] : []
  return [line('Total', report.totals, report.currency), '', ...(top.length > 0 ? top : ['No printing in this period.']), ...more]
}

/** Emails one schedule's report for the cycle that just ended. Returns whether it went out. */
async function send(ctx: Ctx, row: ScheduleRow): Promise<boolean> {
  const inst = await loadInstance(ctx.env)
  if (!outboundEnabled(ctx.env, inst)) return false
  const schedule = toSchedule(row)
  const usage = await loadUsageSettings(ctx.env, row.workspace_id)
  const report = await usageReport(ctx.env, row.workspace_id, {
    by: schedule.by,
    ...coveredBy(schedule.cycle, usage.timeZone, row.next_run_at),
    timeZone: usage.timeZone,
    currency: usage.currency,
  })
  const to = await all<{ email: string }>(
    ctx.env.DB,
    `SELECT u.email FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? AND u.email IS NOT NULL AND m.user_id IN (SELECT value FROM json_each(?))`,
    row.workspace_id,
    row.recipients,
  )
  if (to.length === 0) return false
  const workspace = await first<{ name: string }>(ctx.env.DB, 'SELECT name FROM workspaces WHERE id = ?', row.workspace_id)
  const mail = scheduledReportMail({
    to: to.map((t) => t.email),
    app: appName(ctx.env, inst),
    workspace: workspace?.name ?? 'your workspace',
    name: schedule.name,
    period: report.from === report.to ? report.from : `${report.from} to ${report.to}`,
    lines: summary(report),
    url: `${row.origin}/w/${row.workspace_id}/usage/reports`,
    csv: { filename: reportFilename(report), content: reportCsv(report) },
  })
  if (!(await sendMail(ctx.env, mail, inst))) return false
  await audit(ctx, row.workspace_id, 'report.send', row.id, { name: schedule.name, from: report.from, to: report.to, recipients: to.length })
  return true
}

/** Due schedules send where reports are on; every due schedule moves to its next run, so nothing piles up while off. */
export async function sendDueReports(env: Env): Promise<void> {
  const due = await all<ScheduleRow>(env.DB, 'SELECT * FROM report_schedules WHERE next_run_at <= ? ORDER BY next_run_at LIMIT 50', Date.now())
  for (const row of due) {
    const ctx = systemCtx(env, row.origin, (p) => void p.catch(() => undefined))
    const on = (await extensionActive(env, row.workspace_id, EXTENSION)) && (await loadSettings(env, row.workspace_id)).reports.enabled
    const sent = on ? await send(ctx, row).catch((e: unknown) => (console.error('scheduled report failed', row.id, e), false)) : false
    const { timeZone } = await loadUsageSettings(env, row.workspace_id)
    await run(
      env.DB,
      'UPDATE report_schedules SET next_run_at = ?, last_run_at = COALESCE(?, last_run_at) WHERE id = ? AND next_run_at = ?',
      nextRun(toSchedule(row).cycle, timeZone, Math.max(Date.now(), row.next_run_at)),
      sent ? Date.now() : null,
      row.id,
      row.next_run_at,
    )
  }
}
