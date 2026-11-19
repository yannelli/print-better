import { tooMany } from '../http/errors'
import { first, run } from './db'

// Fixed-window counters stored as `challenges` rows (kind 'throttle'), so no extra table is needed.
const id = (key: string) => `throttle:${key}`

/** Increments the counter for `key` and returns the new count within the current window. */
export async function hit(env: Env, key: string, windowMs: number): Promise<number> {
  const now = Date.now()
  const row = await first<{ data: string }>(
    env.DB,
    `INSERT INTO challenges (id, kind, user_id, data, expires_at) VALUES (?, 'throttle', NULL, '1', ?)
     ON CONFLICT(id) DO UPDATE SET
       data = CASE WHEN challenges.expires_at <= ? THEN '1' ELSE CAST(CAST(challenges.data AS INTEGER) + 1 AS TEXT) END,
       expires_at = CASE WHEN challenges.expires_at <= ? THEN excluded.expires_at ELSE challenges.expires_at END
     RETURNING data`,
    id(key),
    now + windowMs,
    now,
    now,
  )
  return Number(row?.data ?? 1)
}

export async function count(env: Env, key: string): Promise<number> {
  const row = await first<{ data: string; expires_at: number }>(env.DB, 'SELECT data, expires_at FROM challenges WHERE id = ?', id(key))
  return row && row.expires_at > Date.now() ? Number(row.data) : 0
}

export async function reset(env: Env, key: string): Promise<void> {
  await run(env.DB, 'DELETE FROM challenges WHERE id = ?', id(key))
}

/** Rejects once `key` already has `max` hits in its window. */
export async function assertUnder(env: Env, key: string, max: number): Promise<void> {
  if ((await count(env, key)) >= max) throw tooMany()
}

/** Counts this attempt and rejects when it exceeds `max` per window. */
export async function limit(env: Env, key: string, max: number, windowMs: number): Promise<void> {
  if ((await hit(env, key, windowMs)) > max) throw tooMany()
}
