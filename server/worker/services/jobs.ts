import { TERMINAL_JOB_STATUSES, type Job, type JobStatus } from '../../shared/printing'
import { JOB_VIEW, toJob } from '../db/map'
import type { JobViewRow } from '../db/rows'
import { badRequest, conflict, forbidden, notFound } from '../http/errors'
import { all, first, run } from '../lib/db'
import { decodeCursor, pageLimit, toPage, type Page } from '../lib/pagination'
import { requireMember, requireScope } from './access'
import { audit } from './audit'
import type { Ctx } from './context'
import { hubFor, notifyHub } from './hub'
import { canManageJob, loadJobView } from './job-create'

const STATUSES: JobStatus[] = ['uploading', 'queued', 'dispatched', 'printing', 'completed', 'failed', 'canceled']
export const isTerminal = (status: string): boolean => (TERMINAL_JOB_STATUSES as readonly string[]).includes(status)

export interface JobQuery {
  printerId?: string | null
  status?: string | null
  cursor?: string | null
  limit?: string | null
}

export async function listJobs(ctx: Ctx, workspaceId: string, q: JobQuery = {}): Promise<Page<Job>> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId)
  if (q.status && !STATUSES.includes(q.status as JobStatus)) throw badRequest(`status must be one of: ${STATUSES.join(', ')}`)
  const n = pageLimit(q.limit)
  const c = decodeCursor(q.cursor)
  const rows = await all<JobViewRow>(
    ctx.env.DB,
    `${JOB_VIEW} WHERE j.workspace_id = ? AND (? IS NULL OR j.printer_id = ?) AND (? IS NULL OR j.status = ?)
       AND (? IS NULL OR j.created_at < ? OR (j.created_at = ? AND j.id < ?))
     ORDER BY j.created_at DESC, j.id DESC LIMIT ?`,
    workspaceId,
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
  return toPage(rows, n, (r) => ({ createdAt: r.created_at, id: r.id }), toJob)
}

export async function getJob(ctx: Ctx, workspaceId: string, id: string): Promise<Job> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId)
  return toJob(await loadJobView(ctx.env, workspaceId, id))
}

/** The stored document (until purged), for the job page's download button. */
export async function jobDocument(ctx: Ctx, workspaceId: string, id: string): Promise<{ job: JobViewRow; object: R2ObjectBody }> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId)
  const job = await loadJobView(ctx.env, workspaceId, id)
  const object = job.file_key ? await ctx.env.FILES.get(job.file_key) : null
  if (!object) throw notFound('The document is no longer stored', 'file_purged')
  return { job, object }
}

async function manageable(ctx: Ctx, workspaceId: string, id: string): Promise<JobViewRow> {
  const { user, role } = await requireMember(ctx, workspaceId)
  const job = await loadJobView(ctx.env, workspaceId, id)
  if (!canManageJob(job, user.id, role)) throw forbidden('Only admins can manage other people’s jobs')
  return job
}

async function finishAndBroadcast(ctx: Ctx, workspaceId: string, id: string): Promise<Job> {
  const job = toJob(await loadJobView(ctx.env, workspaceId, id))
  notifyHub(ctx, workspaceId, (hub) => hub.broadcast([{ type: 'job', job }]))
  return job
}

/** Not yet with a device: canceled here. Otherwise the device is told to stop and reports the final state. */
export async function cancelJob(ctx: Ctx, workspaceId: string, id: string): Promise<Job> {
  requireScope(ctx, 'print')
  return cancelOwnedJob(ctx, await manageable(ctx, workspaceId, id))
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
  const local = job.status === 'uploading' || job.status === 'queued' ? await cancelHere('Canceled', ['uploading', 'queued']) : 0
  if (local === 0) {
    const delivered = await hubFor(ctx.env, workspaceId)
      .cancelJob(workspaceId, id)
      .catch(() => false)
    if (delivered) await run(ctx.env.DB, "UPDATE jobs SET status_message = 'Canceling…', updated_at = ? WHERE id = ? AND status IN ('dispatched', 'printing')", now, id)
    else await cancelHere('Canceled while the device was offline', ['queued', 'dispatched', 'printing'])
  }
  await audit(ctx, workspaceId, 'job.cancel', id)
  return finishAndBroadcast(ctx, workspaceId, id)
}

/** A fresh attempt on the same job id; the device dedups by (id, attempt). */
export async function retryJob(ctx: Ctx, workspaceId: string, id: string): Promise<Job> {
  requireScope(ctx, 'print')
  const job = await manageable(ctx, workspaceId, id)
  if (job.status !== 'failed' && job.status !== 'canceled') throw conflict('Only failed or canceled jobs can be retried', 'job_not_retryable')
  if (!job.file_key) throw conflict('The document was already deleted', 'file_purged')
  if (!job.printer_id) throw conflict('The printer was removed', 'printer_missing')
  const changed = await run(
    ctx.env.DB,
    `UPDATE jobs SET status = 'queued', status_message = NULL, pages = NULL, completed_at = NULL, attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status IN ('failed', 'canceled')`,
    Date.now(),
    id,
  )
  if (changed === 0) throw conflict('This job changed meanwhile; refresh and try again', 'job_not_retryable')
  await audit(ctx, workspaceId, 'job.retry', id, { attempt: job.attempts + 1 })
  notifyHub(ctx, workspaceId, (hub) => hub.dispatch(workspaceId, id))
  return toJob(await loadJobView(ctx.env, workspaceId, id))
}

export async function deleteJob(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  requireScope(ctx, 'print')
  await requireMember(ctx, workspaceId, 'admin')
  const job = await loadJobView(ctx.env, workspaceId, id)
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
