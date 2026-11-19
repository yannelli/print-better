import type { ChallengeRow } from '../db/rows'
import { first, run } from './db'

// Short-lived server-side state (WebAuthn challenges, OIDC state, reset links), always consumed exactly once.

export async function putChallenge(env: Env, id: string, kind: string, userId: string | null, data: unknown, ttlMs: number): Promise<void> {
  await run(
    env.DB,
    'INSERT INTO challenges (id, kind, user_id, data, expires_at) VALUES (?, ?, ?, ?, ?)',
    id,
    kind,
    userId,
    JSON.stringify(data),
    Date.now() + ttlMs,
  )
}

/** Reads a challenge without consuming it (e.g. an OAuth request shown on the consent page). */
export async function peekChallenge<T>(env: Env, kind: string, id: string): Promise<{ userId: string | null; data: T } | null> {
  const row = await first<ChallengeRow>(env.DB, 'SELECT * FROM challenges WHERE id = ? AND kind = ? AND expires_at > ?', id, kind, Date.now())
  return row ? { userId: row.user_id, data: JSON.parse(row.data) as T } : null
}

/** Atomically deletes and returns the challenge; a second caller (replay) gets null. */
export async function takeChallenge<T>(env: Env, kind: string, id: string): Promise<{ userId: string | null; data: T } | null> {
  const row = await first<ChallengeRow>(env.DB, 'DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING *', id, kind)
  if (!row || row.expires_at <= Date.now()) return null
  return { userId: row.user_id, data: JSON.parse(row.data) as T }
}
