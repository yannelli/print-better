import { JOB_VIEW } from '../../db/map'
import type { JobViewRow } from '../../db/rows'
import { all, stmt } from '../../lib/db'
import { systemCtx } from '../../services/context'
import { hubFor } from '../../services/hub'
import type { CronHook } from '../hooks'
import { settle } from './settle'

interface OpenRow {
  workspace_id: string
  job_id: string
  attempt: number
  /** Null when the job is gone. */
  attempts: number | null
}

/** Ledger rows still estimated whose attempt ended without settling, e.g. because a finish hook failed. */
async function sweep(env: Env): Promise<void> {
  const open = await all<OpenRow>(
    env.DB,
    `SELECT e.workspace_id, e.job_id, e.attempt, j.attempts FROM usage_entries e LEFT JOIN jobs j ON j.id = e.job_id
     WHERE e.estimated = 1 AND (j.id IS NULL OR j.attempts <> e.attempt OR j.status IN ('completed', 'failed', 'canceled'))
     ORDER BY e.at LIMIT 500`,
  )
  if (open.length === 0) return
  const now = Date.now()
  const ctx = systemCtx(env, '', (p) => void p.catch(() => undefined))
  // A retried attempt failed or was canceled and its pages are no longer known; a deleted job keeps its estimate.
  const closed = open.flatMap((r) => {
    if (r.attempts === null) return [stmt(env.DB, 'UPDATE usage_entries SET estimated = 0, settled_at = ? WHERE job_id = ? AND attempt = ?', now, r.job_id, r.attempt)]
    if (r.attempts === r.attempt) return []
    const zero = 'jobs = 0, pages = 0, sheets = 0, color_pages = 0, cost_micros = 0'
    return [stmt(env.DB, `UPDATE usage_entries SET ${zero}, estimated = 0, settled_at = ? WHERE job_id = ? AND attempt = ?`, now, r.job_id, r.attempt)]
  })
  if (closed.length > 0) await env.DB.batch(closed)
  const ended = open.filter((r) => r.attempts === r.attempt).map((r) => r.job_id)
  const rows = ended.length > 0 ? await all<JobViewRow>(env.DB, `${JOB_VIEW} WHERE j.id IN (SELECT value FROM json_each(?))`, JSON.stringify(ended)) : []
  for (const workspaceId of new Set(open.map((r) => r.workspace_id))) {
    try {
      await settle(ctx, workspaceId, rows.filter((r) => r.workspace_id === workspaceId))
    } catch (e) {
      // Its rows stay open for the next run; the other workspaces still settle.
      console.error('settling usage failed', workspaceId, e)
      continue
    }
    await hubFor(env, workspaceId)
      .broadcast([{ type: 'usage' }])
      .catch(() => undefined)
  }
}

export const settlementSweep: CronHook = { name: 'settleUsage', run: sweep }
