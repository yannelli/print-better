import type { UserRow } from '../db/rows'
import { newToken, sha256Hex } from '../lib/crypto'
import { first, run } from '../lib/db'
import { DAY, HOUR } from '../lib/time'

export const SESSION_TTL = 30 * DAY
// Sliding expiry is written at most hourly so ordinary requests stay read-only.
const TOUCH_EVERY = HOUR

export interface ClientMeta {
  ip: string | null
  userAgent: string | null
}

/** Returns the `pbs_` cookie value; only its SHA-256 (the session id) is stored. */
export async function createSession(env: Env, userId: string, meta: ClientMeta): Promise<string> {
  const token = newToken('pbs_')
  const now = Date.now()
  await run(
    env.DB,
    'INSERT INTO sessions (id, user_id, user_agent, ip, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    await sha256Hex(token),
    userId,
    meta.userAgent?.slice(0, 300) ?? null,
    meta.ip,
    now,
    now,
    now + SESSION_TTL,
  )
  return token
}

export interface SessionLookup {
  sessionId: string
  user: UserRow
  /** Expiry was extended, so the cookie should be re-sent. */
  refreshed: boolean
}

export async function lookupSession(env: Env, token: string): Promise<SessionLookup | null> {
  if (!token.startsWith('pbs_')) return null
  const id = await sha256Hex(token)
  const row = await first<UserRow & { s_last_seen_at: number; s_expires_at: number }>(
    env.DB,
    `SELECT u.*, s.last_seen_at AS s_last_seen_at, s.expires_at AS s_expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    id,
  )
  if (!row) return null
  const now = Date.now()
  if (row.s_expires_at <= now) {
    await revokeSession(env, id)
    return null
  }
  const refreshed = now - row.s_last_seen_at > TOUCH_EVERY
  if (refreshed) await run(env.DB, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now, now + SESSION_TTL, id)
  return { sessionId: id, user: row, refreshed }
}

export async function revokeSession(env: Env, id: string): Promise<void> {
  await run(env.DB, 'DELETE FROM sessions WHERE id = ?', id)
}

export async function revokeUserSessions(env: Env, userId: string, exceptId: string | null = null): Promise<void> {
  await run(env.DB, 'DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?', userId, exceptId)
}
