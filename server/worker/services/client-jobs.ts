import { DOC_TYPES, type Job } from '../../shared/printing'
import { JOB_VIEW, PRINTER_VIEW, toJob } from '../db/map'
import type { ClientRow, JobViewRow, PrinterViewRow } from '../db/rows'
import { MB, type Json } from '../http/body'
import { badRequest, forbidden, notFound, tooLarge } from '../http/errors'
import { int, str } from '../http/validate'
import { first } from '../lib/db'
import type { Ctx } from './context'
import { docType } from './doc-types'
import { queueJob, workspaceLimits } from './job-create'
import { parseJobOptions } from './job-options'
import { cancelOwnedJob } from './jobs'
import { deviceAccess } from './permissions'
import { storeUpload } from './upload'

/** Names copied from a print dialog (document, user) are clipped rather than rejected, so a long title still prints. */
function clipped(body: Json, key: string, max: number): string | null {
  const v = body[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw badRequest(`${key} must be a string`)
  return v.trim().slice(0, max) || null
}

/** What a computer's print queue shows (the client maps the code); 404 when the device can't even see the printer. */
const NOT_ALLOWED_HERE = "You can't print to this printer from this computer"

async function requireDevicePrint(ctx: Ctx, client: ClientRow, printerId: string | null): Promise<void> {
  const access = await deviceAccess(ctx, client)
  if (access.can(printerId, 'print')) return
  throw access.can(printerId, 'view') ? forbidden(NOT_ALLOWED_HERE, 'printer_access_denied') : notFound(NOT_ALLOWED_HERE, 'printer_access_denied')
}

/** `POST /api/client/jobs`: this device prints to an added printer in its workspace; the file follows with PUT. */
export async function createClientJob(ctx: Ctx, client: ClientRow, body: Json): Promise<{ job: Job; uploadUrl: string }> {
  const printerId = str(body, 'printerId', { max: 64 })
  const fileName = clipped(body, 'fileName', 255)
  const contentType = docType(str(body, 'contentType', { max: 100 }), fileName)
  if (!contentType) throw badRequest(`contentType must be one of: ${DOC_TYPES.join(', ')}`, 'unsupported_type')
  const size = int(body, 'size', 1, Number.MAX_SAFE_INTEGER)
  const options = body.options === undefined ? {} : parseJobOptions(body.options)
  const printer = await first<PrinterViewRow>(
    ctx.env.DB,
    `${PRINTER_VIEW} WHERE p.id = ? AND p.workspace_id = ? AND p.added = 1`,
    printerId,
    client.workspace_id,
  )
  if (!printer) throw notFound('Printer not found', 'printer_not_found')
  await requireDevicePrint(ctx, client, printer.id)
  const { maxBytes } = await workspaceLimits(ctx.env, client.workspace_id)
  if (size > maxBytes) throw tooLarge(`Documents are limited to ${maxBytes / MB} MB`)
  const { job, uploadUrl } = await queueJob(ctx, {
    workspaceId: client.workspace_id,
    printer,
    userId: null,
    source: 'device',
    title: clipped(body, 'title', 200),
    options,
    document: { kind: 'upload', fileName, contentType, size },
    maxBytes,
    sourceClientId: client.id,
    requestedBy: clipped(body, 'requestedBy', 100),
    access: await deviceAccess(ctx, client),
    role: null,
  })
  if (!uploadUrl) throw new Error('queueJob opened no upload slot')
  return { job, uploadUrl }
}

/** A device sees only the jobs it created. */
async function ownJob(env: Env, client: ClientRow, id: string): Promise<JobViewRow> {
  const job = await first<JobViewRow>(env.DB, `${JOB_VIEW} WHERE j.id = ? AND j.source_client_id = ?`, id, client.id)
  if (!job) throw notFound('Job not found')
  return job
}

export const getClientJob = async (env: Env, client: ClientRow, id: string): Promise<Job> => toJob(await ownJob(env, client, id))

export async function uploadClientJob(ctx: Ctx, client: ClientRow, id: string, req: Request): Promise<Job> {
  const job = await ownJob(ctx.env, client, id)
  if (job.printer_id) await requireDevicePrint(ctx, client, job.printer_id)
  return storeUpload(ctx, job, req)
}

export const cancelClientJob = async (ctx: Ctx, client: ClientRow, id: string): Promise<Job> => cancelOwnedJob(ctx, await ownJob(ctx.env, client, id))
