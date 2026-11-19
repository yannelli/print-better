import type { JobOffer, JobStatusMsg, LanJobMsg } from '../../shared/protocol'
import type { JobOptions, JobStatus } from '../../shared/printing'
import { JOB_VIEW, SOURCE_CLIENT_NAME, toJob } from '../db/map'
import type { JobRow, JobViewRow } from '../db/rows'
import { loadJobViews } from '../extensions/job-view'
import { extensionActive } from '../extensions/state'
import { sha256 } from '../lib/crypto'
import { all, first, parseJson, run } from '../lib/db'
import { base32 } from '../lib/encoding'
import { isTerminal } from '../services/jobs'

export type OfferRow = JobViewRow & { printer_key: string; client_id: string }
export const OFFER_SELECT = `SELECT j.*, p.name AS printer_name, ${SOURCE_CLIENT_NAME}, p.key AS printer_key, p.client_id FROM jobs j JOIN printers p ON p.id = j.printer_id`

export const toOffer = (r: OfferRow): JobOffer => ({
  id: r.id,
  printerKey: r.printer_key,
  title: r.title,
  contentType: r.content_type,
  size: r.size,
  sha256: r.sha256 ?? '',
  options: parseJson<JobOptions>(r.options, {}),
  fileUrl: `/api/client/jobs/${r.id}/file`,
  attempt: r.attempts,
  createdAt: r.created_at,
})

/** Offers as the printing device may see them: Enterprise controls can hide document names from it. */
export async function offerView(env: Env, workspaceId: string): Promise<(row: OfferRow) => JobOffer> {
  const view = await loadJobViews(env, workspaceId, (id) => extensionActive(env, workspaceId, id))
  if (!view) return toOffer
  return (row) => ({ ...toOffer(row), title: view(toJob(row), { kind: 'device', clientId: row.client_id }).title })
}

/** Everything a (re)connecting device still owes us, oldest first. */
export async function pendingOffers(env: Env, workspaceId: string, clientId: string): Promise<JobOffer[]> {
  const rows = await all<OfferRow>(
    env.DB,
    `${OFFER_SELECT} WHERE p.client_id = ? AND j.status IN ('queued', 'dispatched') AND j.file_key IS NOT NULL ORDER BY j.created_at`,
    clientId,
  )
  return rows.length ? rows.map(await offerView(env, workspaceId)) : []
}

/** Queued jobs a connected device has not acknowledged for a while (a lost dispatch), oldest first. */
export async function stuckOffers(env: Env, workspaceId: string, olderThan: number): Promise<OfferRow[]> {
  return all<OfferRow>(
    env.DB,
    `${OFFER_SELECT} WHERE j.workspace_id = ? AND j.status = 'queued' AND j.file_key IS NOT NULL AND j.updated_at < ? ORDER BY j.created_at LIMIT 100`,
    workspaceId,
    olderThan,
  )
}

// Devices are never offered a held job, so `held` outranks every report and none can move it.
const RANK: Record<JobStatus, number> = { uploading: 0, queued: 1, dispatched: 2, printing: 3, completed: 4, failed: 4, canceled: 4, held: 5 }
const REPORTABLE: JobStatus[] = ['dispatched', 'printing', 'completed', 'failed', 'canceled']

export interface StatusOutcome {
  job: JobViewRow | null
  /** The job was canceled while the device was away and it is still working on it. */
  resendCancel: boolean
}

const NOTHING: StatusOutcome = { job: null, resendCancel: false }

/** Terminal states are final, regressions and other attempts are ignored, duplicates are no-ops. */
export async function applyJobStatus(env: Env, clientId: string, msg: JobStatusMsg): Promise<StatusOutcome> {
  if (typeof msg.jobId !== 'string' || !REPORTABLE.includes(msg.status)) return NOTHING
  const row = await first<JobRow & { client_id: string }>(env.DB, 'SELECT j.*, p.client_id FROM jobs j JOIN printers p ON p.id = j.printer_id WHERE j.id = ?', msg.jobId)
  if (!row || row.client_id !== clientId) return NOTHING
  if (msg.attempt !== undefined && msg.attempt !== row.attempts) return NOTHING
  if (isTerminal(row.status)) return { job: null, resendCancel: row.status === 'canceled' && !isTerminal(msg.status) }
  // printing -> dispatched is the device backing off to retry; nothing reached the printer.
  const retrying = msg.status === 'dispatched' && row.status === 'printing'
  if (RANK[msg.status] < RANK[row.status as JobStatus] && !retrying) return NOTHING
  const message = typeof msg.message === 'string' ? msg.message.slice(0, 500) : msg.status === 'failed' ? 'Printing failed' : null
  const pages = typeof msg.pages === 'number' && Number.isInteger(msg.pages) && msg.pages >= 0 ? msg.pages : row.pages
  if (msg.status === row.status && message === row.status_message && pages === row.pages) return NOTHING
  const now = Date.now()
  const changed = await run(
    env.DB,
    'UPDATE jobs SET status = ?, status_message = ?, pages = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status = ? AND attempts = ?',
    msg.status,
    message,
    pages,
    now,
    isTerminal(msg.status) ? now : null,
    row.id,
    row.status,
    row.attempts,
  )
  if (changed === 0) return NOTHING
  return { job: await first<JobViewRow>(env.DB, `${JOB_VIEW} WHERE j.id = ?`, row.id), resendCancel: false }
}

const LAN_STATUSES: JobStatus[] = ['queued', 'dispatched', 'printing', 'completed', 'failed', 'canceled']

/** LAN-shared jobs are history only; the id is derived from (device, localId) so repeated reports update one row. */
export async function applyLanJob(env: Env, client: { id: string; workspace_id: string }, msg: LanJobMsg): Promise<JobViewRow | null> {
  if (typeof msg.localId !== 'string' || typeof msg.printerKey !== 'string' || !LAN_STATUSES.includes(msg.status)) return null
  const id = base32((await sha256(`lan:${client.id}:${msg.localId}`)).slice(0, 16))
  const now = Date.now()
  const title = typeof msg.title === 'string' && msg.title !== '' ? msg.title.slice(0, 200) : 'LAN print'
  const contentType = typeof msg.contentType === 'string' ? msg.contentType.slice(0, 100) : 'application/octet-stream'
  const size = typeof msg.size === 'number' && msg.size >= 0 ? Math.floor(msg.size) : 0
  const message = typeof msg.message === 'string' ? msg.message.slice(0, 500) : null
  await run(
    env.DB,
    `INSERT INTO jobs (id, workspace_id, printer_id, user_id, source, title, content_type, size, options, status, status_message, attempts, created_at, updated_at, completed_at)
     VALUES (?, ?, (SELECT id FROM printers WHERE client_id = ? AND key = ?), NULL, 'lan', ?, ?, ?, '{}', ?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, status_message = excluded.status_message,
       updated_at = excluded.updated_at, completed_at = excluded.completed_at
     WHERE jobs.status NOT IN ('completed', 'failed', 'canceled')`,
    id,
    client.workspace_id,
    client.id,
    msg.printerKey,
    title,
    contentType,
    size,
    msg.status,
    message,
    now,
    now,
    isTerminal(msg.status) ? now : null,
  )
  return first<JobViewRow>(env.DB, `${JOB_VIEW} WHERE j.id = ?`, id)
}
