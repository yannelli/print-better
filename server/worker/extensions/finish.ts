import type { UiEvent } from '../../shared/protocol'
import { JOB_VIEW } from '../db/map'
import type { JobViewRow } from '../db/rows'
import { all, parseJson } from '../lib/db'
import type { Ctx } from '../services/context'
import { JOB_FINISH_HOOKS } from './hooks'
import { isActive } from './state'

const estimated = (row: JobViewRow): boolean => row.usage !== null && parseJson<{ estimated?: boolean }>(row.usage, {}).estimated === true

/** Jobs that just ended (completed, failed or canceled): settles their usage, then whatever else extensions do. */
export async function runFinishHooks(ctx: Ctx, workspaceId: string, jobs: readonly JobViewRow[]): Promise<void> {
  if (jobs.length === 0) return
  for (const hook of JOB_FINISH_HOOKS) {
    if (hook.extension && !(await isActive(ctx, workspaceId, hook.extension))) continue
    try {
      await hook.finished(ctx, workspaceId, jobs)
    } catch (e) {
      // The cron settles whatever a failed hook left estimated.
      console.error('job finish hook failed', e)
    }
  }
}

export interface Ended {
  /** The rows as they are now; reloaded only for jobs whose usage was still an estimate. */
  rows: JobViewRow[]
  /** Usage was settled: open pages should hear a `usage` event. */
  events: UiEvent[]
}

/** Runs the finish hooks and returns the rows to show. Jobs never counted cost no extra query. */
export async function jobsEnded(ctx: Ctx, workspaceId: string, rows: JobViewRow[]): Promise<Ended> {
  const counted = rows.filter(estimated)
  await runFinishHooks(ctx, workspaceId, rows)
  if (counted.length === 0) return { rows, events: [] }
  const ids = JSON.stringify(counted.map((r) => r.id))
  const fresh = new Map((await all<JobViewRow>(ctx.env.DB, `${JOB_VIEW} WHERE j.id IN (SELECT value FROM json_each(?))`, ids)).map((r) => [r.id, r]))
  return { rows: rows.map((r) => fresh.get(r.id) ?? r), events: [{ type: 'usage' }] }
}
