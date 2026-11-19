import type { Job, JobHold, JobNote, JobPolicy } from '../../../shared/printing'
import type { UiEvent } from '../../../shared/protocol'
import { JOB_VIEW, toJob } from '../../db/map'
import type { JobViewRow } from '../../db/rows'
import { conflict } from '../../http/errors'
import { all, parseJson, run } from '../../lib/db'
import { audit } from '../../services/audit'
import type { Ctx } from '../../services/context'
import { hubFor, notifyHub } from '../../services/hub'
import { loadJobView } from '../../services/job-create'
import { jobsEnded } from '../finish'
import { deviceTitle } from '../job-view'
import { HOLD_MESSAGES } from '../usage/outcome'

export const holdOf = (row: Pick<JobViewRow, 'status' | 'held'>): JobHold | null => (row.status === 'held' ? parseJson<JobHold | null>(row.held, null) : null)

export const OFF_MESSAGE = 'Enterprise controls were turned off'

const NOT_HELD: Record<JobHold['kind'], string> = {
  approval: 'This job isn’t waiting for approval',
  release: 'This job isn’t waiting to be released',
}

export const notHeld = (kind: JobHold['kind']) => conflict(NOT_HELD[kind], 'job_not_held')

/** A held job of `kind`, or 409 job_not_held. */
export function requireHeld(row: JobViewRow, kind: JobHold['kind']): JobHold {
  const hold = holdOf(row)
  if (hold?.kind !== kind) throw notHeld(kind)
  return hold
}

const withNote = (row: JobViewRow, note: JobNote): string => {
  const policy = parseJson<JobPolicy>(row.policy, { notes: [] })
  return JSON.stringify({ ...policy, notes: [...policy.notes, note] })
}

export type Next = { status: 'queued' } | { status: 'held'; hold: JobHold }

/** Moves a held job on: to the queue, or to its next hold. Only the hold it was in can be left, and only before it expires. */
export async function moveOn(ctx: Ctx, row: JobViewRow, from: JobHold['kind'], next: Next, note?: JobNote): Promise<Job> {
  const hold = next.status === 'held' ? next.hold : null
  const now = Date.now()
  const changed = await run(
    ctx.env.DB,
    `UPDATE jobs SET status = ?, status_message = ?, held = ?, policy = ?, updated_at = ?
     WHERE id = ? AND status = 'held' AND json_extract(held, '$.kind') = ? AND json_extract(held, '$.until') > ?`,
    next.status,
    hold ? HOLD_MESSAGES[hold.kind] : null,
    hold && JSON.stringify(hold),
    note ? withNote(row, note) : row.policy,
    now,
    row.id,
    from,
    now,
  )
  if (changed === 0) throw notHeld(from)
  notifyHub(ctx, row.workspace_id, async (hub) => hub.dispatch(row.workspace_id, row.id, await deviceTitle(ctx, row.workspace_id, row.id)))
  return toJob(await loadJobView(ctx.env, row.workspace_id, row.id))
}

export interface Ending {
  message: string
  /** Audited for each job, e.g. approval.expire. */
  action: string
  /** Ends only jobs still in this hold; any hold when absent. */
  kind?: JobHold['kind']
  /** Ends only jobs whose hold has run out. */
  expired?: boolean
  note?: JobNote
  deleteDocuments?: boolean
}

/** Cancels held jobs with a message, audits each, settles their usage and tells open pages. Returns the jobs it ended. */
export async function endHeld(ctx: Ctx, workspaceId: string, rows: readonly JobViewRow[], end: Ending): Promise<JobViewRow[]> {
  const now = Date.now()
  const ended: string[] = []
  for (const row of rows) {
    const changed = await run(
      ctx.env.DB,
      `UPDATE jobs SET status = 'canceled', status_message = ?, policy = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'held' AND (? IS NULL OR json_extract(held, '$.kind') = ?) AND (? = 0 OR json_extract(held, '$.until') <= ?)`,
      end.message,
      end.note ? withNote(row, end.note) : row.policy,
      now,
      now,
      row.id,
      end.kind ?? null,
      end.kind ?? null,
      end.expired ? 1 : 0,
      now,
    )
    if (changed > 0) ended.push(row.id)
  }
  if (ended.length === 0) return []
  const ids = JSON.stringify(ended)
  if (end.deleteDocuments) {
    const keys = rows.filter((r) => ended.includes(r.id) && r.file_key).map((r) => r.file_key as string)
    if (keys.length > 0) await ctx.env.FILES.delete(keys)
    await run(ctx.env.DB, 'UPDATE jobs SET file_key = NULL WHERE id IN (SELECT value FROM json_each(?))', ids)
  }
  for (const id of ended) await audit(ctx, workspaceId, end.action, id, { message: end.message })
  const fresh = await all<JobViewRow>(ctx.env.DB, `${JOB_VIEW} WHERE j.id IN (SELECT value FROM json_each(?))`, ids)
  const done = await jobsEnded(ctx, workspaceId, fresh)
  const events: UiEvent[] = [...done.rows.map((r) => ({ type: 'job' as const, job: toJob(r) })), ...done.events]
  await hubFor(ctx.env, workspaceId)
    .broadcast(events)
    .catch((e: unknown) => console.error('hub call failed', e))
  return done.rows
}

/** Held jobs in a workspace, optionally of one kind, oldest first. */
export const heldJobs = (env: Env, workspaceId: string, kind?: JobHold['kind']): Promise<JobViewRow[]> =>
  all<JobViewRow>(
    env.DB,
    `${JOB_VIEW} WHERE j.workspace_id = ? AND j.status = 'held' AND (? IS NULL OR json_extract(j.held, '$.kind') = ?) ORDER BY j.created_at, j.id`,
    workspaceId,
    kind ?? null,
    kind ?? null,
  )
