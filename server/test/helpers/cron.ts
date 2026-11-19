import { env } from 'cloudflare:workers'
import type { Owner } from './world'

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Queues a text job through the REST API and returns its id. */
export async function textJob(owner: Owner, printerId: string, text = 'hello'): Promise<string> {
  const reply = await owner.agent.post(`/api/workspaces/${owner.workspaceId}/jobs`, { printerId, text })
  if (reply.status !== 200) throw new Error(`job create failed: ${reply.status} ${JSON.stringify(reply.body)}`)
  return reply.body.job.id
}

/** Rewrites job columns directly, to move a job through time without waiting. */
export async function setJob(id: string, fields: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(fields)
  await env.DB.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id)
    .run()
}

export interface JobRow {
  status: string
  status_message: string | null
  file_key: string | null
  completed_at: number | null
}

export async function jobRow(id: string): Promise<JobRow> {
  const row = await env.DB.prepare('SELECT status, status_message, file_key, completed_at FROM jobs WHERE id = ?').bind(id).first<JobRow>()
  if (!row) throw new Error(`job ${id} is gone`)
  return row
}

export const exists = async (table: string, where: string, ...args: unknown[]): Promise<boolean> =>
  (await env.DB.prepare(`SELECT 1 AS one FROM ${table} WHERE ${where}`).bind(...args).first()) !== null

export async function patchWorkspaceSettings(owner: Owner, settings: Record<string, unknown>): Promise<void> {
  const reply = await owner.agent.patch(`/api/workspaces/${owner.workspaceId}`, { settings })
  if (reply.status !== 200) throw new Error(`workspace patch failed: ${reply.status} ${JSON.stringify(reply.body)}`)
}
