import type { DocType, Job, JobOptions, JobSource } from '../../shared/printing'
import { DOC_TYPES } from '../../shared/printing'
import { JOB_VIEW, PRINTER_VIEW, toJob, workspaceSettings } from '../db/map'
import type { JobViewRow, PrinterViewRow } from '../db/rows'
import { MB, readBytes, type Json } from '../http/body'
import { badRequest, conflict, notFound } from '../http/errors'
import { int, obj, optStr, str } from '../http/validate'
import { newId, sha256Hex } from '../lib/crypto'
import { first, run } from '../lib/db'
import { fromB64, utf8 } from '../lib/encoding'
import { VERSION } from '../version'
import { requireScope } from './access'
import { audit } from './audit'
import type { Ctx } from './context'
import { docType } from './doc-types'
import { notifyHub } from './hub'
import { parseJobOptions } from './job-options'
import { memberAccess, requirePermission, type Access } from './permissions'
import { loadWorkspace } from './workspaces'

export type DocumentInput =
  | { kind: 'upload'; fileName: string | null; contentType: DocType; size: number }
  | { kind: 'text'; text: string }
  | { kind: 'url'; url: string }
  | { kind: 'bytes'; data: Uint8Array; contentType: DocType; fileName: string | null }

export interface QueueInput {
  workspaceId: string
  printer: PrinterViewRow
  userId: string | null
  source: JobSource
  title: string | null
  options: JobOptions
  document: DocumentInput
  maxBytes: number
  /** Source `device` only. */
  sourceClientId?: string
  requestedBy?: string | null
}

export async function workspaceLimits(env: Env, workspaceId: string): Promise<{ maxBytes: number; defaultPrinterId: string | null }> {
  const settings = workspaceSettings((await loadWorkspace(env, workspaceId)).settings)
  return { maxBytes: settings.maxUploadMb * MB, defaultPrinterId: settings.defaultPrinterId }
}

/** Falls back to the workspace default printer; only added printers the caller may print to accept jobs. */
export async function resolvePrinter(env: Env, workspaceId: string, printerId: string | null, defaultId: string | null, access: Access): Promise<PrinterViewRow> {
  const id = printerId ?? defaultId
  if (!id) throw badRequest('Choose a printer (this workspace has no default printer)', 'printer_required')
  const row = await first<PrinterViewRow>(env.DB, `${PRINTER_VIEW} WHERE p.id = ? AND p.workspace_id = ?`, id, workspaceId)
  if (!row) throw notFound('Printer not found')
  requirePermission(access, row.id, 'print')
  if (row.added !== 1) throw conflict('Add this printer to the workspace before printing to it', 'printer_not_added')
  return row
}

function decodeBase64(body: Json, maxBytes: number): DocumentInput {
  const fileName = str(body, 'fileName', { max: 255 })
  const contentType = docType(str(body, 'contentType', { max: 100 }), fileName)
  if (!contentType) throw badRequest(`contentType must be one of: ${DOC_TYPES.join(', ')}`, 'unsupported_type')
  const encoded = str(body, 'base64', { max: Math.ceil(maxBytes / 3) * 4 + 1024 }).replace(/\s+/g, '')
  try {
    return { kind: 'bytes', data: fromB64(encoded), contentType, fileName }
  } catch {
    throw badRequest('base64 is not valid base64')
  }
}

function parseDocument(body: Json, maxBytes: number): DocumentInput {
  const given = ['upload', 'text', 'url', 'base64'].filter((k) => body[k] !== undefined)
  if (given.length !== 1) throw badRequest('Provide exactly one of upload, text, url, or base64')
  if (body.base64 !== undefined) return decodeBase64(body, maxBytes)
  if (body.upload !== undefined) {
    const u = obj(body, 'upload')
    const contentType = docType(str(u, 'contentType', { max: 100 }))
    if (!contentType) throw badRequest(`contentType must be one of: ${DOC_TYPES.join(', ')}`, 'unsupported_type')
    return { kind: 'upload', fileName: str(u, 'fileName', { max: 255 }), contentType, size: int(u, 'size', 1, maxBytes) }
  }
  if (body.text !== undefined) {
    if (typeof body.text !== 'string' || body.text.trim() === '') throw badRequest('text must be a non-empty string')
    if (body.text.length > Math.min(maxBytes, 5 * MB)) throw badRequest('text is too long', 'too_large')
    return { kind: 'text', text: body.text }
  }
  return { kind: 'url', url: str(body, 'url', { max: 2000, pattern: /^https?:\/\/\S+$/i, hint: 'url must be an http(s) URL' }) }
}

/** `POST /workspaces/:ws/jobs`: an upload slot (two-step), text, a URL the server fetches, or inline base64. */
export async function createJob(ctx: Ctx, workspaceId: string, body: Json): Promise<{ job: Job; uploadUrl?: string }> {
  requireScope(ctx, 'print')
  const { user, access } = await memberAccess(ctx, workspaceId)
  const limits = await workspaceLimits(ctx.env, workspaceId)
  const document = parseDocument(body, limits.maxBytes)
  const printer = await resolvePrinter(ctx.env, workspaceId, optStr(body, 'printerId', { max: 64 }) ?? null, limits.defaultPrinterId, access)
  return queueJob(ctx, {
    workspaceId,
    printer,
    userId: user.id,
    source: ctx.via ?? (ctx.actor.type === 'user' ? 'web' : 'api'),
    title: optStr(body, 'title', { max: 200 }) ?? null,
    options: body.options === undefined ? {} : parseJobOptions(body.options),
    document,
    maxBytes: limits.maxBytes,
  })
}

async function fetchDocument(url: string, maxBytes: number): Promise<{ data: Uint8Array; contentType: DocType; fileName: string | null }> {
  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': `PrintBetter/${VERSION}`, Accept: DOC_TYPES.join(', ') } })
  } catch (e) {
    throw badRequest(`Could not fetch the URL: ${e instanceof Error ? e.message : String(e)}`, 'fetch_failed')
  }
  if (!res.ok) throw badRequest(`The URL returned HTTP ${res.status}`, 'fetch_failed')
  const path = new URL(res.url || url).pathname
  const fileName = decodeURIComponent(path.split('/').pop() ?? '') || null
  const contentType = docType(res.headers.get('Content-Type'), fileName)
  if (!contentType) throw badRequest(`The URL is not a supported document (${DOC_TYPES.join(', ')})`, 'unsupported_type')
  return { data: await readBytes(res, maxBytes), contentType, fileName }
}

async function materialize(doc: Exclude<DocumentInput, { kind: 'upload' }>, maxBytes: number) {
  if (doc.kind === 'bytes') return { data: doc.data, contentType: doc.contentType, fileName: doc.fileName, title: doc.fileName }
  if (doc.kind === 'url') {
    const fetched = await fetchDocument(doc.url, maxBytes)
    return { ...fetched, title: fetched.fileName ?? new URL(doc.url).hostname }
  }
  const firstLine = doc.text.trim().split('\n')[0].slice(0, 60)
  return { data: utf8(doc.text), contentType: 'text/plain' as const, fileName: null, title: firstLine || 'Text' }
}

export const jobFileKey = (workspaceId: string, jobId: string) => `jobs/${workspaceId}/${jobId}`

export async function loadJobView(env: Env, workspaceId: string, id: string): Promise<JobViewRow> {
  const row = await first<JobViewRow>(env.DB, `${JOB_VIEW} WHERE j.id = ? AND j.workspace_id = ?`, id, workspaceId)
  if (!row) throw notFound('Job not found')
  return row
}

/** Shared by REST, MCP, email-to-print and the test page: stores the document (or opens an upload slot) and dispatches. */
export async function queueJob(ctx: Ctx, p: QueueInput): Promise<{ job: Job; uploadUrl?: string }> {
  const id = newId()
  const now = Date.now()
  const insert = (status: 'uploading' | 'queued', fileKey: string | null, fileName: string | null, contentType: string, size: number, sha: string | null, title: string) =>
    run(
      ctx.env.DB,
      `INSERT INTO jobs (id, workspace_id, printer_id, user_id, source, title, file_key, file_name, content_type, size, sha256, options, status, attempts, created_at, updated_at, source_client_id, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id,
      p.workspaceId,
      p.printer.id,
      p.userId,
      p.source,
      title,
      fileKey,
      fileName,
      contentType,
      size,
      sha,
      JSON.stringify(p.options),
      status,
      now,
      now,
      p.sourceClientId ?? null,
      p.requestedBy ?? null,
    )

  if (p.document.kind === 'upload') {
    const d = p.document
    await insert('uploading', null, d.fileName, d.contentType, d.size, null, p.title ?? d.fileName ?? 'Document')
    await audit(ctx, p.workspaceId, 'job.create', id, { source: p.source, printerId: p.printer.id })
    const job = toJob(await loadJobView(ctx.env, p.workspaceId, id))
    notifyHub(ctx, p.workspaceId, (hub) => hub.broadcast([{ type: 'job', job }]))
    const path = p.source === 'device' ? `/api/client/jobs/${id}/file` : `/api/workspaces/${p.workspaceId}/jobs/${id}/file`
    return { job, uploadUrl: `${ctx.origin}${path}` }
  }

  const doc = await materialize(p.document, p.maxBytes)
  if (doc.data.byteLength === 0) throw badRequest('The document is empty')
  if (doc.data.byteLength > p.maxBytes) throw badRequest(`Documents are limited to ${p.maxBytes / MB} MB`, 'too_large')
  const key = jobFileKey(p.workspaceId, id)
  await ctx.env.FILES.put(key, doc.data, { httpMetadata: { contentType: doc.contentType } })
  await insert('queued', key, doc.fileName, doc.contentType, doc.data.byteLength, await sha256Hex(doc.data), p.title ?? doc.title ?? 'Document')
  await audit(ctx, p.workspaceId, 'job.create', id, { source: p.source, printerId: p.printer.id })
  notifyHub(ctx, p.workspaceId, (hub) => hub.dispatch(p.workspaceId, id))
  return { job: toJob(await loadJobView(ctx.env, p.workspaceId, id)) }
}
