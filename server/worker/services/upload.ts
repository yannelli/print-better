import type { Job } from '../../shared/printing'
import { toJob } from '../db/map'
import type { JobViewRow } from '../db/rows'
import { jobsEnded } from '../extensions/finish'
import { deviceTitle, jobViewer } from '../extensions/job-view'
import { usageActive } from '../extensions/usage/active'
import { checkUpload, recheck, unchanged, uploadUpdate, type Checked } from '../extensions/usage/attempts'
import { entryInsert, refuse, runAfter } from '../extensions/usage/outcome'
import { ApiError, badRequest, conflict } from '../http/errors'
import { run } from '../lib/db'
import { hex } from '../lib/encoding'
import { requireScope } from './access'
import { audit } from './audit'
import type { Ctx } from './context'
import { docType } from './doc-types'
import { notifyHub } from './hub'
import { jobFor } from './job-access'
import { jobFileKey, loadJobView } from './job-create'

/** Second upload step: streams the body to R2 through a SHA-256 tap, then queues and dispatches the job. */
export async function uploadJobFile(ctx: Ctx, workspaceId: string, id: string, req: Request): Promise<Job> {
  requireScope(ctx, 'print')
  const { job, user, role } = await jobFor(ctx, workspaceId, id, 'upload')
  const stored = await storeUpload(ctx, job, req)
  return (await jobViewer(ctx, workspaceId, { kind: 'member', userId: user.id, role }))(stored)
}

/** The upload itself, once the caller is known to own `job` (REST or device endpoint). */
export async function storeUpload(ctx: Ctx, job: JobViewRow, req: Request): Promise<Job> {
  const { workspace_id: workspaceId, id } = job
  if (job.status !== 'uploading') throw conflict('This job is not waiting for an upload', 'not_uploading')
  const declaredType = req.headers.get('Content-Type')
  if (declaredType && docType(declaredType, job.file_name) !== job.content_type) {
    throw new ApiError(415, 'unsupported_type', `Content-Type must be ${job.content_type}`)
  }
  const length = req.headers.get('Content-Length')
  if (length !== null && Number(length) !== job.size) throw badRequest(`Upload must be exactly ${job.size} bytes`, 'size_mismatch')
  if (!req.body) throw badRequest('The request has no body')

  const key = jobFileKey(workspaceId, id)
  const digest = new crypto.DigestStream('SHA-256')
  const hashWriter = digest.getWriter()
  // R2 needs a known length; FixedLengthStream also fails the write when the body is shorter or longer than declared.
  const fixed = new FixedLengthStream(job.size)
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await hashWriter.write(chunk)
      controller.enqueue(chunk)
    },
    async flush() {
      await hashWriter.close()
    },
  })
  try {
    await Promise.all([
      req.body.pipeThrough(tap).pipeTo(fixed.writable),
      ctx.env.FILES.put(key, fixed.readable, { httpMetadata: { contentType: job.content_type } }),
    ])
  } catch (e) {
    await ctx.env.FILES.delete(key).catch(() => undefined)
    console.warn('upload failed', id, e)
    throw badRequest(`Upload must be exactly ${job.size} bytes`, 'size_mismatch')
  }
  const sha = hex(await digest.digest)
  const checked = (await usageActive(ctx, workspaceId)) ? await checkUpload(ctx, job, key) : null
  if (checked?.accepted.decision.block) await refuseUpload(ctx, job, key, checked)
  const changed = checked
    ? (await ctx.env.DB.batch([uploadUpdate(ctx.env, job, key, sha, checked.accepted), entryInsert(ctx.env, checked.draft, checked.accepted)]))[0].meta.changes
    : await run(ctx.env.DB, "UPDATE jobs SET status = 'queued', file_key = ?, sha256 = ?, updated_at = ? WHERE id = ? AND status = 'uploading'", key, sha, Date.now(), id)
  if (changed === 0) {
    if (checked?.accepted.guard && (await unchanged(ctx.env, job))) await refuseUpload(ctx, job, key, await recheck(() => checkUpload(ctx, job, key)))
    await ctx.env.FILES.delete(key)
    throw conflict('This job was canceled during the upload', 'not_uploading')
  }
  await audit(ctx, workspaceId, 'job.upload', id, { size: job.size })
  notifyHub(ctx, workspaceId, async (hub) => {
    await hub.dispatch(workspaceId, id, await deviceTitle(ctx, workspaceId, id))
    if (checked) await hub.broadcast([{ type: 'usage' }])
  })
  const stored = toJob(await loadJobView(ctx.env, workspaceId, id))
  if (checked) runAfter(ctx, checked.accepted.decision, stored)
  return stored
}

/** A refused upload: its file is deleted, the job becomes canceled with the message, and the caller gets 403 policy_blocked. */
async function refuseUpload(ctx: Ctx, job: JobViewRow, key: string, checked: Checked): Promise<never> {
  const { decision } = checked.accepted
  await ctx.env.FILES.delete(key)
  const now = Date.now()
  const changed = await run(
    ctx.env.DB,
    "UPDATE jobs SET status = 'canceled', status_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'uploading'",
    decision.block,
    now,
    now,
    job.id,
  )
  if (changed > 0) {
    const ended = await jobsEnded(ctx, job.workspace_id, [await loadJobView(ctx.env, job.workspace_id, job.id)])
    notifyHub(ctx, job.workspace_id, (hub) => hub.broadcast([...ended.rows.map((row) => ({ type: 'job' as const, job: toJob(row) })), ...ended.events]))
  }
  return refuse(ctx, checked.draft, decision)
}
