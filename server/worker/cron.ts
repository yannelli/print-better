import type { UiEvent } from '../shared/protocol'
import { DEFAULT_WORKSPACE_SETTINGS } from '../shared/types'
import { SOURCE_CLIENT_NAME, toClient, toJob } from './db/map'
import type { ClientRow, JobViewRow } from './db/rows'
import { all, chunk, placeholders, run, stmt } from './lib/db'
import { DAY, HOUR } from './lib/time'
import { hubFor } from './services/hub'

const TERMINAL = "('completed', 'failed', 'canceled')"

/** Deletes stored documents of finished jobs once they are older than the workspace's keepDocumentsHours. */
async function purgeDocuments(env: Env): Promise<void> {
  for (let round = 0; round < 10; round++) {
    const rows = await all<{ id: string; file_key: string }>(
      env.DB,
      `SELECT j.id, j.file_key FROM jobs j JOIN workspaces w ON w.id = j.workspace_id
       WHERE j.file_key IS NOT NULL AND j.status IN ${TERMINAL}
         AND COALESCE(j.completed_at, j.updated_at) < ? - COALESCE(json_extract(w.settings, '$.keepDocumentsHours'), ?) * ?
       LIMIT 500`,
      Date.now(),
      DEFAULT_WORKSPACE_SETTINGS.keepDocumentsHours,
      HOUR,
    )
    if (rows.length === 0) return
    await env.FILES.delete(rows.map((r) => r.file_key))
    for (const ids of chunk(rows.map((r) => r.id), 90)) {
      await run(env.DB, `UPDATE jobs SET file_key = NULL WHERE id IN (${placeholders(ids.length)})`, ...ids)
    }
  }
}

async function purgeExpired(env: Env): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    stmt(env.DB, 'DELETE FROM sessions WHERE expires_at <= ?', now),
    stmt(env.DB, 'DELETE FROM challenges WHERE expires_at <= ?', now),
    stmt(env.DB, 'DELETE FROM enrollment_tokens WHERE expires_at <= ?', now),
    stmt(env.DB, 'DELETE FROM device_codes WHERE expires_at <= ?', now),
    stmt(env.DB, 'DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?', now),
    stmt(env.DB, 'DELETE FROM invites WHERE accepted_at IS NULL AND expires_at <= ?', now),
    stmt(
      env.DB,
      'DELETE FROM oauth_clients WHERE created_at <= ? AND NOT EXISTS (SELECT 1 FROM api_tokens t WHERE t.oauth_client_id = oauth_clients.id)',
      now - 30 * DAY,
    ),
  ])
}

type StaleRow = JobViewRow & { client_id: string | null; timeout_hours: number }

/** Uploads abandoned for an hour, and jobs with no progress for jobTimeoutHours, become failed. */
async function failStaleJobs(env: Env): Promise<void> {
  const now = Date.now()
  const stale = await all<StaleRow>(
    env.DB,
    `SELECT j.*, p.name AS printer_name, ${SOURCE_CLIENT_NAME}, p.client_id,
            COALESCE(json_extract(w.settings, '$.jobTimeoutHours'), ?) AS timeout_hours
     FROM jobs j JOIN workspaces w ON w.id = j.workspace_id LEFT JOIN printers p ON p.id = j.printer_id
     WHERE (j.status = 'uploading' AND j.updated_at < ?)
        OR (j.status IN ('queued', 'dispatched', 'printing')
            AND j.updated_at < ? - COALESCE(json_extract(w.settings, '$.jobTimeoutHours'), ?) * ?)
     LIMIT 500`,
    DEFAULT_WORKSPACE_SETTINGS.jobTimeoutHours,
    now - HOUR,
    now,
    DEFAULT_WORKSPACE_SETTINGS.jobTimeoutHours,
    HOUR,
  )
  const events = new Map<string, UiEvent[]>()
  for (const job of stale) {
    const message = job.status === 'uploading' ? 'The upload never finished' : `Gave up after ${job.timeout_hours} hours without finishing`
    const changed = await run(
      env.DB,
      "UPDATE jobs SET status = 'failed', status_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?",
      message,
      now,
      now,
      job.id,
      job.status,
    )
    if (changed === 0) continue
    const hub = hubFor(env, job.workspace_id)
    if (job.status === 'dispatched' || job.status === 'printing') await hub.cancelJob(job.workspace_id, job.id).catch(() => false)
    const list = events.get(job.workspace_id) ?? []
    list.push({ type: 'job', job: { ...toJob(job), status: 'failed', statusMessage: message, completedAt: now, updatedAt: now } })
    events.set(job.workspace_id, list)
  }
  for (const [workspaceId, list] of events) await hubFor(env, workspaceId).broadcast(list)
}

/** Clients marked online whose hub no longer holds a socket (e.g. after an eviction) are marked offline. */
async function syncOnline(env: Env): Promise<void> {
  const workspaces = await all<{ workspace_id: string }>(env.DB, 'SELECT DISTINCT workspace_id FROM clients WHERE online = 1')
  for (const { workspace_id: workspaceId } of workspaces) {
    const hub = hubFor(env, workspaceId)
    const snapshotAt = Date.now()
    const live = JSON.stringify(await hub.liveClientIds())
    await run(env.DB, 'UPDATE clients SET last_seen_at = ? WHERE id IN (SELECT value FROM json_each(?))', Date.now(), live)
    // A device whose hello landed after the snapshot has a newer last_seen_at and stays online.
    const gone = await all<ClientRow>(
      env.DB,
      'UPDATE clients SET online = 0 WHERE workspace_id = ? AND online = 1 AND last_seen_at < ? AND id NOT IN (SELECT value FROM json_each(?)) RETURNING *',
      workspaceId,
      snapshotAt,
      live,
    )
    if (gone.length > 0) await hub.broadcast(gone.map((c) => ({ type: 'client', client: toClient(c) })))
  }
}

export async function runCron(env: Env): Promise<void> {
  const tasks = { purgeDocuments, purgeExpired, failStaleJobs, syncOnline }
  const results = await Promise.allSettled(Object.values(tasks).map((task) => task(env)))
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`cron ${Object.keys(tasks)[i]} failed`, r.reason)
  })
}
