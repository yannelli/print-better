import type { Job } from '../../shared/printing'
import { toJob } from '../db/map'
import type { JobViewRow } from '../db/rows'
import { ApiError, badRequest, conflict, forbidden } from '../http/errors'
import { run } from '../lib/db'
import { hex } from '../lib/encoding'
import { requireMember, requireScope } from './access'
import { audit } from './audit'
import type { Ctx } from './context'
import { docType } from './doc-types'
import { notifyHub } from './hub'
import { canManageJob, jobFileKey, loadJobView } from './job-create'

/** Second upload step: streams the body to R2 through a SHA-256 tap, then queues and dispatches the job. */
export async function uploadJobFile(ctx: Ctx, workspaceId: string, id: string, req: Request): Promise<Job> {
  requireScope(ctx, 'print')
  const { user, role } = await requireMember(ctx, workspaceId)
  const job = await loadJobView(ctx.env, workspaceId, id)
  if (!canManageJob(job, user.id, role)) throw forbidden('Only the person who created this job can upload its file')
  return storeUpload(ctx, job, req)
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
  const changed = await run(
    ctx.env.DB,
    "UPDATE jobs SET status = 'queued', file_key = ?, sha256 = ?, updated_at = ? WHERE id = ? AND status = 'uploading'",
    key,
    sha,
    Date.now(),
    id,
  )
  if (changed === 0) {
    await ctx.env.FILES.delete(key)
    throw conflict('This job was canceled during the upload', 'not_uploading')
  }
  await audit(ctx, workspaceId, 'job.upload', id, { size: job.size })
  notifyHub(ctx, workspaceId, (hub) => hub.dispatch(workspaceId, id))
  return toJob(await loadJobView(ctx.env, workspaceId, id))
}
