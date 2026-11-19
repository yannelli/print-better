import type { ReportDimension, UsageReport, UsageReportRow, UsageTotals } from '../../../shared/enterprise'
import { badRequest } from '../../http/errors'
import { all } from '../../lib/db'
import type { LocalDate } from '../usage/cycles'
import { csv, decimal } from './csv'
import { daySpans, DIMENSIONS, formatDate } from './values'

const SUMS = 'SUM(e.jobs) AS jobs, SUM(e.pages) AS pages, SUM(e.sheets) AS sheets, SUM(e.color_pages) AS colorPages, SUM(e.cost_micros) AS costMicros'
const RANGE = 'e.workspace_id = ? AND e.at >= ? AND e.at < ?'

/** Each dimension's key column and its name, joined from the table it points to. */
const GROUPED: Record<Exclude<ReportDimension, 'group'>, { key: string; name: string; join: string }> = {
  member: { key: 'e.user_id', name: 'u.name', join: 'LEFT JOIN users u ON u.id = e.user_id' },
  device: { key: 'e.client_id', name: 'c.name', join: 'LEFT JOIN clients c ON c.id = e.client_id' },
  printer: { key: 'e.printer_id', name: 'p.name', join: 'LEFT JOIN printers p ON p.id = e.printer_id' },
  'cost-center': { key: 'e.cost_center_id', name: 'cc.name', join: 'LEFT JOIN cost_centers cc ON cc.id = e.cost_center_id' },
  source: { key: 'e.source', name: 'NULL', join: '' },
}

const NONE: Record<ReportDimension, string> = {
  member: 'No member',
  group: 'No group',
  device: 'No device',
  printer: 'Removed printer',
  'cost-center': 'No cost center',
  source: 'Unknown',
}

const SOURCES: Record<string, string> = { web: 'Web app', api: 'API', mcp: 'AI assistant', email: 'Email to print', device: 'Print window', test: 'Test page' }

type SumRow = UsageTotals & { key: string | null; name: string | null }

const zero = (): UsageTotals => ({ jobs: 0, pages: 0, sheets: 0, colorPages: 0, costMicros: 0 })
const totalsOf = (r: Partial<UsageTotals>): UsageTotals => ({
  jobs: r.jobs ?? 0,
  pages: r.pages ?? 0,
  sheets: r.sheets ?? 0,
  colorPages: r.colorPages ?? 0,
  costMicros: r.costMicros ?? 0,
})

/** A member in two groups counts in both; entries in no group get their own row. */
const groupRows = (env: Env, workspaceId: string, start: number, end: number) =>
  all<SumRow>(
    env.DB,
    `WITH ranged AS (SELECT * FROM usage_entries e WHERE ${RANGE}),
          tagged AS (SELECT DISTINCT gm.group_id, r.id FROM ranged r JOIN group_members gm ON gm.workspace_id = r.workspace_id AND (gm.user_id = r.user_id OR gm.client_id = r.client_id))
     SELECT t.group_id AS key, g.name AS name, ${SUMS} FROM tagged t JOIN ranged e ON e.id = t.id JOIN groups g ON g.id = t.group_id GROUP BY t.group_id
     UNION ALL
     SELECT NULL AS key, NULL AS name, ${SUMS} FROM ranged e WHERE e.id NOT IN (SELECT id FROM tagged) HAVING COUNT(*) > 0`,
    workspaceId,
    start,
    end,
  )

async function sums(env: Env, workspaceId: string, by: ReportDimension, start: number, end: number): Promise<SumRow[]> {
  if (by === 'group') return groupRows(env, workspaceId, start, end)
  const d = GROUPED[by]
  return all<SumRow>(env.DB, `SELECT ${d.key} AS key, ${d.name} AS name, ${SUMS} FROM usage_entries e ${d.join} WHERE ${RANGE} GROUP BY ${d.key}`, workspaceId, start, end)
}

export function parseDimension(value: string | null): ReportDimension {
  if (!DIMENSIONS.includes(value as ReportDimension)) throw badRequest(`by must be one of: ${DIMENSIONS.join(', ')}`)
  return value as ReportDimension
}

/** Usage from `from` to `to`, both included, in the workspace time zone. Never shows document names. */
export async function usageReport(env: Env, workspaceId: string, q: { by: ReportDimension; from: LocalDate; to: LocalDate; timeZone: string; currency: string }): Promise<UsageReport> {
  const spans = daySpans(q.timeZone, q.from, q.to)
  const start = spans[0].start
  const end = spans[spans.length - 1].end
  const [grouped, perDay] = await Promise.all([
    sums(env, workspaceId, q.by, start, end),
    all<UsageTotals & { i: number }>(
      env.DB,
      `SELECT b.key AS i, ${SUMS} FROM json_each(?) b JOIN usage_entries e ON ${RANGE.replace('e.at >= ? AND e.at < ?', "e.at >= json_extract(b.value, '$[0]') AND e.at < json_extract(b.value, '$[1]')")}
       GROUP BY b.key`,
      JSON.stringify(spans.map((s) => [s.start, s.end])),
      workspaceId,
    ),
  ])
  const rows: UsageReportRow[] = grouped
    .map((r) => ({ key: r.key, name: (q.by === 'source' && r.key ? SOURCES[r.key] : r.name) ?? NONE[q.by], ...totalsOf(r) }))
    .sort((a, b) => b.costMicros - a.costMicros || b.pages - a.pages || a.name.localeCompare(b.name))
  const days = spans.map((s, i) => ({ day: s.day, ...totalsOf(perDay.find((d) => d.i === i) ?? {}) }))
  const totals = days.reduce((sum, d) => {
    for (const k of Object.keys(sum) as (keyof UsageTotals)[]) sum[k] += d[k]
    return sum
  }, zero())
  return { by: q.by, from: formatDate(q.from), to: formatDate(q.to), currency: q.currency, rows, totals, days }
}

export const REPORT_COLUMNS = ['name', 'key', 'jobs', 'pages', 'sheets', 'colorPages', 'cost'] as const

export const reportCsv = (report: UsageReport): string =>
  csv(
    REPORT_COLUMNS,
    report.rows.map((r) => [r.name, r.key, r.jobs, r.pages, r.sheets, r.colorPages, decimal(r.costMicros, report.currency)]),
  )

export const reportFilename = (report: Pick<UsageReport, 'by' | 'from' | 'to'>): string => `usage-by-${report.by}-${report.from}-to-${report.to}.csv`
