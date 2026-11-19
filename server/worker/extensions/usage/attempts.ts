import { bytesSource, countPages } from '../../../shared/pages'
import type { DocType, JobOptions, JobPolicy, JobSource, JobUsage } from '../../../shared/printing'
import { PRINTER_VIEW } from '../../db/map'
import type { JobViewRow, PrinterViewRow } from '../../db/rows'
import { conflict } from '../../http/errors'
import { first, parseJson, stmt } from '../../lib/db'
import type { Ctx } from '../../services/context'
import type { JobDraft } from '../hooks'
import { jobDraft, runJobCheck, type Sender } from './check'
import { printerFacts } from './estimate'
import { accepted, refuseIfBlocked, type Accepted, type Requested } from './outcome'
import { countStored, senderOf, textPaper } from './sender'

/** A job about to be created, before the core stores anything. */
export interface NewJob {
  workspaceId: string
  jobId: string
  source: Exclude<JobSource, 'lan'>
  sender: Sender
  printer: PrinterViewRow
  options: JobOptions
  contentType: DocType
  size: number
  costCenter: unknown
}

export interface Checked {
  draft: JobDraft
  accepted: Accepted
}

const draftOf = (ctx: Ctx, job: NewJob, documentPages: number | null, counted: boolean) =>
  jobDraft(ctx, { ...job, attempt: 1, documentPages, counted })

/** An upload slot, before any byte arrives: each copy counts as 1 page, so most refusals come before the upload. */
export async function checkSlot(ctx: Ctx, job: NewJob): Promise<Accepted> {
  const draft = await draftOf(ctx, job, null, false)
  const decision = await runJobCheck(ctx, draft, job.printer, job.options)
  await refuseIfBlocked(ctx, draft, decision)
  return accepted(decision, { printerId: job.printer.id, options: job.options })
}

/** A document in hand (text, URL, base64, email, test page), counted before anything is stored. */
export async function checkInline(ctx: Ctx, job: NewJob, data: Uint8Array): Promise<Checked> {
  const pages = await countPages(bytesSource(data), job.contentType, textPaper(printerFacts(job.printer), job.options))
  const draft = await draftOf(ctx, job, pages, true)
  const decision = await runJobCheck(ctx, draft, job.printer, job.options)
  await refuseIfBlocked(ctx, draft, decision)
  return { draft, accepted: accepted(decision, { printerId: job.printer.id, options: job.options }) }
}

const addedPrinter = (env: Env, workspaceId: string, id: string | null): Promise<PrinterViewRow | null> =>
  first<PrinterViewRow>(env.DB, `${PRINTER_VIEW} WHERE p.id = ? AND p.workspace_id = ? AND p.added = 1`, id, workspaceId)

/** A stored job checked again: an upload whose file just arrived, or a retry. */
async function checkStored(ctx: Ctx, row: JobViewRow, asked: Requested, attempt: number, documentPages?: number | null): Promise<Checked> {
  const sender = await senderOf(ctx, row)
  const start = sender.access.can(asked.printerId, 'print') ? asked.printerId : row.printer_id
  const printer = (await addedPrinter(ctx.env, row.workspace_id, start)) ?? (await addedPrinter(ctx.env, row.workspace_id, row.printer_id))
  if (!printer) throw conflict('The printer was removed', 'printer_missing')
  const contentType = row.content_type as DocType
  const pages = documentPages !== undefined ? documentPages : await countStored(ctx.env, row.file_key ?? '', row.size, contentType, textPaper(printerFacts(printer), asked.options))
  const draft = await jobDraft(ctx, {
    workspaceId: row.workspace_id,
    jobId: row.id,
    attempt,
    source: row.source as NewJob['source'],
    sender,
    contentType,
    size: row.size,
    documentPages: pages,
    counted: true,
    costCenter: row.cost_center_id,
  })
  const decision = await runJobCheck(ctx, draft, printer, asked.options)
  return { draft, accepted: accepted(decision, asked) }
}

const askedOf = (row: JobViewRow): Requested =>
  parseJson<JobPolicy | null>(row.policy, null)?.requested ?? { printerId: row.printer_id ?? '', options: parseJson<JobOptions>(row.options, {}) }

/** The upload's file is stored at `key`; the caller cancels the job when the check refuses it. */
export const checkUpload = (ctx: Ctx, row: JobViewRow, key: string): Promise<Checked> => checkStored(ctx, { ...row, file_key: key }, askedOf(row), row.attempts)

/** A retry starts from what the sender asked for, while they may still print there; a refused retry leaves the job as it was. */
export async function checkRetry(ctx: Ctx, row: JobViewRow): Promise<Checked> {
  const counted = parseJson<JobUsage | null>(row.usage, null)
  const checked = await checkStored(ctx, row, askedOf(row), row.attempts + 1, counted ? counted.documentPages : undefined)
  await refuseIfBlocked(ctx, checked.draft, checked.accepted.decision)
  return checked
}

/** For a check that no longer blocks: a limit was full when the job was stored. */
const FILLED_UP = 'Other jobs sent at the same time used up a limit. Try again.'

/** Checks again after a guarded write changed nothing, so the refusal says what is left now. */
export async function recheck(check: () => Promise<Checked>): Promise<Checked> {
  const checked = await check()
  checked.accepted.decision.block ??= FILLED_UP
  return checked
}

/** After a write that changed nothing: the job is still as it was read, so its guard is what stopped it. */
export const unchanged = async (env: Env, row: JobViewRow): Promise<boolean> =>
  (await first(env.DB, 'SELECT id FROM jobs WHERE id = ? AND status = ? AND attempts = ?', row.id, row.status, row.attempts)) !== null

const guarded = (a: Accepted): string => (a.guard ? ` AND ${a.guard.sql}` : '')

/** `uploading` becomes `queued` or `held` with what the check decided. */
export const uploadUpdate = (env: Env, row: JobViewRow, key: string, sha: string, a: Accepted): D1PreparedStatement =>
  stmt(
    env.DB,
    `UPDATE jobs SET status = ?, status_message = ?, file_key = ?, sha256 = ?, printer_id = ?, options = ?, policy = ?, held = ?, usage = ?, cost_center_id = ?, updated_at = ?
     WHERE id = ? AND status = 'uploading'${guarded(a)}`,
    a.status,
    a.statusMessage,
    key,
    sha,
    a.printerId,
    a.options,
    a.policy,
    a.held,
    a.usage,
    a.costCenterId,
    Date.now(),
    row.id,
    ...(a.guard?.params ?? []),
  )

/** The next attempt of a failed or canceled job. */
export const retryUpdate = (env: Env, row: JobViewRow, a: Accepted): D1PreparedStatement =>
  stmt(
    env.DB,
    `UPDATE jobs SET status = ?, status_message = ?, pages = NULL, completed_at = NULL, attempts = attempts + 1, printer_id = ?, options = ?, policy = ?, held = ?,
       usage = ?, cost_center_id = ?, updated_at = ?
     WHERE id = ? AND status IN ('failed', 'canceled') AND attempts = ?${guarded(a)}`,
    a.status,
    a.statusMessage,
    a.printerId,
    a.options,
    a.policy,
    a.held,
    a.usage,
    a.costCenterId,
    Date.now(),
    row.id,
    row.attempts,
    ...(a.guard?.params ?? []),
  )
