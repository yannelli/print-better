import { TERMINAL_JOB_STATUSES, type JobOptions, type JobUsage } from '../../../shared/printing'
import type { JobViewRow } from '../../db/rows'
import { all, parseJson, stmt } from '../../lib/db'
import type { Ctx } from '../../services/context'
import type { JobFinishHook } from '../hooks'
import { costOf, printerFacts, printsInColor, printsTwoSided, type PrinterFacts } from './estimate'
import { pricesFor, usageSettings, type UsageSettings } from './settings'

const openEstimate = (row: JobViewRow): JobUsage | null => {
  const usage = parseJson<JobUsage | null>(row.usage, null)
  return usage?.estimated && (TERMINAL_JOB_STATUSES as readonly string[]).includes(row.status) ? usage : null
}

/** What an ended attempt counts: what printed when the device said, else the estimate if it completed, else nothing. */
export function settledUsage(row: JobViewRow, estimate: JobUsage, printer: PrinterFacts | undefined, settings: UsageSettings): { jobs: number; usage: JobUsage } {
  const completed = row.status === 'completed'
  const pages = row.pages ?? (completed ? estimate.pages : 0)
  const jobs = completed ? 1 : 0
  if (pages === estimate.pages) return { jobs, usage: { ...estimate, estimated: false } }
  const options = parseJson<JobOptions>(row.options, {})
  const shape = printer
    ? { color: printsInColor(printer, options), twoSided: printsTwoSided(printer, options) }
    : { color: estimate.colorPages > 0, twoSided: estimate.sheets < estimate.pages }
  const counts = costOf(pages, shape, pricesFor(settings, row.printer_id))
  return { jobs, usage: { documentPages: estimate.documentPages, pages, ...counts, estimated: false } }
}

async function printersOf(env: Env, rows: JobViewRow[]): Promise<Map<string, PrinterFacts>> {
  const ids = [...new Set(rows.flatMap((r) => (r.printer_id ? [r.printer_id] : [])))]
  if (ids.length === 0) return new Map()
  const printers = await all<{ id: string; capabilities: string; defaults: string }>(
    env.DB,
    'SELECT id, capabilities, defaults FROM printers WHERE id IN (SELECT value FROM json_each(?))',
    JSON.stringify(ids),
  )
  return new Map(printers.map((p) => [p.id, printerFacts(p)]))
}

/** Settles the ledger row of each ended attempt and the job's `usage`. Jobs never counted are skipped without a query. */
export async function settle(ctx: Ctx, workspaceId: string, jobs: readonly JobViewRow[]): Promise<void> {
  const open = jobs.flatMap((row) => {
    const estimate = openEstimate(row)
    return estimate ? [{ row, estimate }] : []
  })
  if (open.length === 0) return
  const [settings, printers] = await Promise.all([usageSettings(ctx, workspaceId), printersOf(ctx.env, open.map((o) => o.row))])
  const now = Date.now()
  await ctx.env.DB.batch(
    open.flatMap(({ row, estimate }) => {
      const { jobs: count, usage } = settledUsage(row, estimate, row.printer_id ? printers.get(row.printer_id) : undefined, settings)
      return [
        stmt(
          ctx.env.DB,
          `UPDATE usage_entries SET jobs = ?, pages = ?, sheets = ?, color_pages = ?, cost_micros = ?, estimated = 0, settled_at = ?
           WHERE job_id = ? AND attempt = ? AND estimated = 1`,
          count,
          usage.pages,
          usage.sheets,
          usage.colorPages,
          usage.costMicros,
          now,
          row.id,
          row.attempts,
        ),
        stmt(ctx.env.DB, 'UPDATE jobs SET usage = ? WHERE id = ? AND attempts = ?', JSON.stringify(usage), row.id, row.attempts),
      ]
    }),
  )
}

/** Runs with both extensions off too, so usage recorded while one was on still settles. */
export const settlement: JobFinishHook = { extension: null, finished: settle }
