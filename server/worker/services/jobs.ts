import { TERMINAL_JOB_STATUSES, type Job, type JobStatus } from '../../shared/printing'
import type { Role } from '../../shared/types'
import { JOB_VIEW, toJob } from '../db/map'
import type { JobViewRow, UserRow } from '../db/rows'
import { jobsEnded } from '../extensions/finish'
import { deviceTitle, jobViewer } from '../extensions/job-view'
import { isActive } from '../extensions/state'
import { usageActive } from '../extensions/usage/active'
import { checkRetry, retryUpdate } from '../extensions/usage/attempts'
import { entryInsert, runAfter } from '../extensions/usage/outcome'
import { badRequest, conflict, notFound } from '../http/errors'
import { all, first, run } from '../lib/db'
import { decodeCursor, pageLimit, toPage, type Page } from '../lib/pagination'
import { requireScope } from './access'
import { genericFileName } from './doc-types'
import { audit } from './audit'
import type { Ctx } from './context'
import { hubFor, notifyHub } from './hub'
import { jobFor, jobScope } from './job-access'
import { loadJobView } from './job-create'
import { memberAccess } from './permissions'

const STATUSES: JobStatus[] = ['uploading', 'queued', 'dispatched', 'printing', 'completed', 'failed', 'canceled']
export const isTerminal = (status: string): boolean => (TERMINAL_JOB_STATUSES as readonly string[]).includes(status)

/** Jobs that haven't ended, as an SQL list; removing their printer or device cancels them. */
export const OPEN = "('uploading', 'held', 'queued', 'dispatched', 'printing')"

export interface JobQuery {
  printerId?: string | null
  status?: string | null
  cursor?: string | null
  limit?: string | null
}

/** `held` exists only while Enterprise controls is active; otherwise it is refused like any unknown status. */
const knownStatus = async (ctx: Ctx, workspaceId: string, status: string): Promise<boolean> =>
  STATUSES.includes(status as JobStatus) || (status === 'held' && (await isActive(ctx, workspaceId, 'enterprise')))

export async function listJobs(ctx: Ctx, workspaceId: string, q: JobQuery = {}): Promise<Page<Job>> {
  requireScope(ctx, 'read')
  const { user, role, access } = await memberAccess(ctx, workspaceId)
  if (q.status && !(await knownStatus(ctx, workspaceId, q.status))) throw badRequest(`status must be one of: ${STATUSES.join(', ')}`)
  const n = pageLimit(q.limit)
  const c = decodeCursor(q.cursor)
  const scope = await jobScope(ctx.env, workspaceId, user.id, access)
  const rows = await all<JobViewRow>(
    ctx.env.DB,
    `${JOB_VIEW} WHERE j.workspace_id = ?${scope.sql} AND (? IS NULL OR j.printer_id = ?) AND (? IS NULL OR j.status = ?)
       AND (? IS NULL OR j.created_at < ? OR (j.created_at = ? AND j.id < ?))
     ORDER BY j.created_at DESC, j.id DESC LIMIT ?`,
    workspaceId,
    ...scope.args,
    q.printerId || null,
    q.printerId || null,
    q.status || null,
    q.status || null,
    c?.createdAt ?? null,
    c?.createdAt ?? null,
    c?.createdAt ?? null,
    c?.id ?? null,
    n + 1,
  )
  const view = await jobViewer(ctx, workspaceId, { kind: 'member', userId: user.id, role })
  return toPage(rows, n, (r) => ({ createdAt: r.created_at, id: r.id }), (r) => view(toJob(r)))
}

/** What the caller may see of jobs (Enterprise controls can hide document names). */
const memberView = (ctx: Ctx, workspaceId: string, found: { user: UserRow; role: Role }) =>
  jobViewer(ctx, workspaceId, { kind: 'member', userId: found.user.id, role: found.role })

export async function getJob(ctx: Ctx, workspaceId: string, id: string): Promise<Job> {
  requireScope(ctx, 'read')
  const found = await jobFor(ctx, workspaceId, id)
  return (await memberView(ctx, workspaceId, found))(toJob(found.job))
}

/** The stored document (until purged), with the file name the caller may see, for the job page's download button. */
export async function jobDocument(ctx: Ctx, workspaceId: string, id: string): Promise<{ job: JobViewRow; object: R2ObjectBody; fileName: string }> {
  requireScope(ctx, 'read')
  const found = await jobFor(ctx, workspaceId, id)
  const { job } = found
  const object = job.file_key ? await ctx.env.FILES.get(job.file_key) : null
  if (!object) throw notFound('The document is no longer stored', 'file_purged')
  const shown = (await memberView(ctx, workspaceId, found))(toJob(job))
  const hidden = shown.title !== job.title || shown.fileName !== job.file_name
  return { job, object, fileName: hidden ? genericFileName(job.content_type) : (job.file_name ?? job.title) }
}

/** Broadcasts the job; when this call ended it, the finish hooks run first so the event shows its settled usage. */
async function finishAndBroadcast(ctx: Ctx, workspaceId: string, id: string, ended: boolean): Promise<Job> {
  const row = await loadJobView(ctx.env, workspaceId, id)
  const shown = ended ? await jobsEnded(ctx, workspaceId, [row]) : { rows: [row], events: [] }
  const job = toJob(shown.rows[0])
  notifyHub(ctx, workspaceId, (hub) => hub.broadcast([{ type: 'job', job }, ...shown.events]))
  return job
}

/** Not yet with a device: canceled here. Otherwise the device is told to stop and reports the final state. */
export async function cancelJob(ctx: Ctx, workspaceId: string, id: string): Promise<Job> {
  requireScope(ctx, 'print')
  const found = await jobFor(ctx, workspaceId, id, 'cancel')
  return (await memberView(ctx, workspaceId, found))(await cancelOwnedJob(ctx, found.job))
}

/** The cancel itself, once the caller is known to own `job` (REST or device endpoint). */
export async function cancelOwnedJob(ctx: Ctx, job: JobViewRow): Promise<Job> {
  const { workspace_id: workspaceId, id } = job
  if (isTerminal(job.status)) throw conflict('This job already finished', 'job_finished')
  const now = Date.now()
  const cancelHere = (message: string, from: string[]) =>
    run(
      ctx.env.DB,
      `UPDATE jobs SET status = 'canceled', status_message = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`,
      message,
      now,
      now,
      id,
      ...from,
    )
  const waiting = ['uploading', 'held', 'queued']
  let ended = waiting.includes(job.status) ? await cancelHere('Canceled', waiting) : 0
  if (ended === 0) {
    const delivered = await hubFor(ctx.env, workspaceId)
      .cancelJob(workspaceId, id)
      .catch(() => false)
    if (delivered) await run(ctx.env.DB, "UPDATE jobs SET status_message = 'Canceling…', updated_at = ? WHERE id = ? AND status IN ('dispatched', 'printing')", now, id)
    else ended = await cancelHere('Canceled while the device was offline', ['queued', 'dispatched', 'printing'])
  }
  await audit(ctx, workspaceId, 'job.cancel', id)
  return finishAndBroadcast(ctx, workspaceId, id, ended > 0)
}

/** A fresh attempt on the same job id; the device dedups by (id, attempt). */
export async function retryJob(ctx: Ctx, workspaceId: string, id: string): Promise<Job> {
  requireScope(ctx, 'print')
  const found = await jobFor(ctx, workspaceId, id, 'retry')
  const { job } = found
  if (job.status !== 'failed' && job.status !== 'canceled') throw conflict('Only failed or canceled jobs can be retried', 'job_not_retryable')
  if (!job.file_key) throw conflict('The document was already deleted', 'file_purged')
  if (!job.printer_id) throw conflict('The printer was removed', 'printer_missing')
  const checked = (await usageActive(ctx, workspaceId)) ? await checkRetry(ctx, job) : null
  // `usage` describes the current attempt, so usage recorded while checks were on goes with the old one.
  const changed = checked
    ? (await ctx.env.DB.batch([retryUpdate(ctx.env, job, checked.accepted), entryInsert(ctx.env, checked.draft, checked.accepted)]))[0].meta.changes
    : await run(
        ctx.env.DB,
        `UPDATE jobs SET status = 'queued', status_message = NULL, pages = NULL, completed_at = NULL, attempts = attempts + 1, updated_at = ?${job.usage != null ? ', usage = NULL' : ''}
         WHERE id = ? AND status IN ('failed', 'canceled')`,
        Date.now(),
        id,
      )
  if (changed === 0) throw conflict('This job changed meanwhile; refresh and try again', 'job_not_retryable')
  await audit(ctx, workspaceId, 'job.retry', id, { attempt: job.attempts + 1 })
  notifyHub(ctx, workspaceId, async (hub) => {
    await hub.dispatch(workspaceId, id, await deviceTitle(ctx, workspaceId, id))
    if (checked) await hub.broadcast([{ type: 'usage' }])
  })
  const retried = toJob(await loadJobView(ctx.env, workspaceId, id))
  if (checked) runAfter(ctx, checked.accepted.decision, retried)
  return (await memberView(ctx, workspaceId, found))(retried)
}

export async function deleteJob(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  requireScope(ctx, 'print')
  const { job } = await jobFor(ctx, workspaceId, id, 'delete')
  if (!isTerminal(job.status)) throw conflict('Cancel the job before deleting it', 'job_active')
  if (job.file_key) await ctx.env.FILES.delete(job.file_key)
  await run(ctx.env.DB, 'DELETE FROM jobs WHERE id = ?', id)
  await audit(ctx, workspaceId, 'job.delete', id, { title: job.title })
}

/** Device download: only jobs for printers that belong to this device. */
export async function clientJobDocument(env: Env, clientId: string, jobId: string): Promise<{ job: JobViewRow; object: R2ObjectBody }> {
  const job = await first<JobViewRow>(env.DB, `${JOB_VIEW} WHERE j.id = ? AND p.client_id = ?`, jobId, clientId)
  if (!job) throw notFound('Job not found')
  const object = job.file_key ? await env.FILES.get(job.file_key) : null
  if (!object) throw notFound('The document is no longer stored', 'file_purged')
  return { job, object }
}
