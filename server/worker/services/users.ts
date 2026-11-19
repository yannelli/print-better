import type { UserRow } from '../db/rows'
import { ApiError, conflict } from '../http/errors'
import { newId } from '../lib/crypto'
import { first } from '../lib/db'

export const getUser = (env: Env, id: string): Promise<UserRow | null> => first<UserRow>(env.DB, 'SELECT * FROM users WHERE id = ?', id)

/** `login` is a username or an email; usernames cannot contain "@", so the two never collide. */
export const findUserByLogin = (env: Env, login: string): Promise<UserRow | null> =>
  first<UserRow>(env.DB, 'SELECT * FROM users WHERE username = ? OR email = ?', login, login)

export function uniqueConflict(e: unknown): ApiError | null {
  const msg = String(e)
  if (msg.includes('users.username')) return conflict('That username is taken', 'username_taken')
  if (msg.includes('users.email')) return conflict('That email address is already in use', 'email_taken')
  return null
}

export interface NewUser {
  id?: string
  username: string
  name: string
  email: string | null
  emailVerified: boolean
  passwordHash: string | null
  isAdmin: boolean
}

/** With `onlyIfFirst`, the insert happens only while the users table is empty (first-run setup race guard). */
export async function insertUser(env: Env, u: NewUser, onlyIfFirst = false): Promise<UserRow | null> {
  const now = Date.now()
  const id = u.id ?? newId()
  const values = [id, u.username, u.email?.toLowerCase() ?? null, u.emailVerified ? 1 : 0, u.name, u.passwordHash, u.isAdmin ? 1 : 0, now, now]
  const sql = onlyIfFirst
    ? `INSERT INTO users (id, username, email, email_verified, name, password_hash, is_admin, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING *`
    : `INSERT INTO users (id, username, email, email_verified, name, password_hash, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  try {
    return await first<UserRow>(env.DB, sql, ...values)
  } catch (e) {
    throw uniqueConflict(e) ?? e
  }
}

/** Password, passkeys and linked SSO identities each count as one way to sign in. */
export async function signInMethodCount(env: Env, userId: string): Promise<number> {
  const row = await first<{ n: number }>(
    env.DB,
    `SELECT (CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END)
       + (SELECT COUNT(*) FROM passkeys WHERE user_id = users.id)
       + (SELECT COUNT(*) FROM identities WHERE user_id = users.id) AS n
     FROM users WHERE id = ?`,
    userId,
  )
  return row?.n ?? 0
}

const USERNAME_CHARS = /[^a-z0-9._-]+/g

/** Derives an available username from an email or display name, adding a numeric suffix on collision. */
export async function freeUsername(env: Env, hint: string): Promise<string> {
  const cleaned = hint.toLowerCase().split('@')[0].replace(USERNAME_CHARS, '').replace(/^[._-]+/, '').slice(0, 24)
  const base = cleaned.length >= 2 ? cleaned : 'user'
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`
    if (!(await first(env.DB, 'SELECT 1 AS one FROM users WHERE username = ?', candidate))) return candidate
  }
  return `user${newId().slice(0, 8)}`
}
