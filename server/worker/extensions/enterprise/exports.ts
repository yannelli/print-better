import type { UsageReport } from '../../../shared/enterprise'
import type { AuditRow } from '../../db/rows'
import { all } from '../../lib/db'
import { audit } from '../../services/audit'
import type { Ctx } from '../../services/context'
import { localTime, type LocalDate } from '../usage/cycles'
import { usageSettings } from '../usage/settings'
import { csv, csvResponse } from './csv'
import { enter } from './guard'
import { parseDimension, reportCsv, reportFilename, usageReport } from './reports'
import { daySpans, formatDate, parseDate } from './values'

export interface ReportQuery {
  by: string | null
  from: string | null
  to: string | null
  format: string | null
}

/** Defaults to this month so far. */
function range(q: { from: string | null; to: string | null }, timeZone: string): { from: LocalDate; to: LocalDate } {
  const today = localTime(timeZone, Date.now())
  return {
    from: q.from ? parseDate(q.from, 'from') : { year: today.year, month: today.month, day: 1 },
    to: q.to ? parseDate(q.to, 'to') : { year: today.year, month: today.month, day: today.day },
  }
}

/** `format=csv` answers the CSV and is audited as report.export. */
export async function getUsageReport(ctx: Ctx, workspaceId: string, q: ReportQuery): Promise<UsageReport | Response> {
  await enter(ctx, workspaceId, 'read', 'reports', 'admin')
  const { timeZone, currency } = await usageSettings(ctx, workspaceId)
  const report = await usageReport(ctx.env, workspaceId, { by: parseDimension(q.by), ...range(q, timeZone), timeZone, currency })
  if (q.format !== 'csv') return report
  await audit(ctx, workspaceId, 'report.export', null, { by: report.by, from: report.from, to: report.to })
  return csvResponse(reportCsv(report), reportFilename(report))
}

const AUDIT_COLUMNS = ['time', 'actorType', 'actorId', 'actorName', 'action', 'target', 'data']
const PAGE = 1000
const MAX_ROWS = 100_000

/** The audit log for a date range, oldest first. Document titles follow the privacy settings. */
export async function exportAudit(ctx: Ctx, workspaceId: string, q: { from: string | null; to: string | null }): Promise<Response> {
  const { settings } = await enter(ctx, workspaceId, 'read', 'reports', 'admin')
  const { timeZone } = await usageSettings(ctx, workspaceId)
  const { from, to } = range(q, timeZone)
  const spans = daySpans(timeZone, from, to)
  const hideTitles = settings.privacy.enabled && settings.privacy.ownerOnlyNames && !settings.privacy.adminsSeeNames
  const rows: AuditRow[] = []
  for (let after = 0; rows.length < MAX_ROWS; ) {
    const page = await all<AuditRow>(
      ctx.env.DB,
      `SELECT a.*, COALESCE(u.name, cl.name, CASE WHEN a.actor_type = 'email' THEN a.actor_id END) AS actor_name
       FROM audit_log a
       LEFT JOIN users u ON a.actor_type IN ('user', 'token') AND u.id = a.actor_id
       LEFT JOIN clients cl ON a.actor_type = 'client' AND cl.id = a.actor_id
       WHERE a.workspace_id = ? AND a.created_at >= ? AND a.created_at < ? AND a.id > ? ORDER BY a.id LIMIT ?`,
      workspaceId,
      spans[0].start,
      spans[spans.length - 1].end,
      after,
      PAGE,
    )
    rows.push(...page)
    if (page.length < PAGE) break
    after = page[page.length - 1].id
  }
  const data = (raw: string | null) => {
    if (!raw || !hideTitles) return raw
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!('title' in parsed)) return raw
    return JSON.stringify({ ...parsed, title: 'Document' })
  }
  const text = csv(
    AUDIT_COLUMNS,
    rows.map((r) => [new Date(r.created_at).toISOString(), r.actor_type, r.actor_id, r.actor_name, r.action, r.target, data(r.data)]),
  )
  await audit(ctx, workspaceId, 'audit.export', null, { from: formatDate(from), to: formatDate(to), rows: rows.length })
  return csvResponse(text, `audit-${formatDate(from)}-to-${formatDate(to)}.csv`)
}
