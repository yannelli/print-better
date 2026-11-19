import type { Passkey, SessionInfo, User } from '../../shared/types'
import { hashPassword, verifyPassword } from '../auth/password'
import { revokeSession, revokeUserSessions } from '../auth/sessions'
import { toPasskey, toSession, toUser } from '../db/map'
import type { PasskeyRow, SessionRow, UserRow } from '../db/rows'
import type { Json } from '../http/body'
import { badRequest, conflict, notFound, unauthorized } from '../http/errors'
import { EMAIL, NAME, USERNAME, nullableStr, optStr, password, str } from '../http/validate'
import { all, first, run } from '../lib/db'
import { hit, assertUnder } from '../lib/throttle'
import { HOUR } from '../lib/time'
import { requireScope, requireSessionUser, requireUser } from './access'
import { audit } from './audit'
import type { Ctx } from './context'
import { sendVerificationLater } from './email-verification'
import { getUser, signInMethodCount, uniqueConflict } from './users'

export function getMe(ctx: Ctx): User {
  requireScope(ctx, 'read')
  return toUser(requireUser(ctx))
}

export async function patchMe(ctx: Ctx, body: Json): Promise<User> {
  requireScope(ctx, 'write')
  const user = requireUser(ctx)
  const name = optStr(body, 'name', NAME) ?? user.name
  const username = optStr(body, 'username', USERNAME) ?? user.username
  const emailPatch = nullableStr(body, 'email', EMAIL)
  const email = emailPatch === undefined ? user.email : (emailPatch?.toLowerCase() ?? null)
  const emailChanged = email !== user.email
  try {
    await run(
      ctx.env.DB,
      'UPDATE users SET name = ?, username = ?, email = ?, email_verified = ?, updated_at = ? WHERE id = ?',
      name,
      username,
      email,
      emailChanged ? 0 : user.email_verified,
      Date.now(),
      user.id,
    )
  } catch (e) {
    throw uniqueConflict(e) ?? e
  }
  if (emailChanged || username !== user.username) await audit(ctx, null, 'user.update', user.id, { username, email })
  const updated = (await getUser(ctx.env, user.id)) as UserRow
  if (emailChanged) sendVerificationLater(ctx, updated)
  return toUser(updated)
}

/** Signs out every other session, since a changed password usually means a suspected compromise. */
export async function changePassword(ctx: Ctx, body: Json): Promise<void> {
  const { user, sessionId } = requireSessionUser(ctx)
  const next = password(body, 'next')
  if (user.password_hash) {
    const current = body.current
    if (typeof current !== 'string' || current === '') throw badRequest('current password is required')
    await assertUnder(ctx.env, `password:${user.id}`, 10)
    if (!(await verifyPassword(ctx.env, current, user.password_hash)).ok) {
      await hit(ctx.env, `password:${user.id}`, HOUR)
      throw unauthorized('Current password is wrong', 'invalid_credentials')
    }
  }
  await run(ctx.env.DB, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(ctx.env, next), Date.now(), user.id)
  await revokeUserSessions(ctx.env, user.id, sessionId)
  await audit(ctx, null, 'password.update', user.id)
}

export async function listPasskeys(ctx: Ctx): Promise<Passkey[]> {
  requireScope(ctx, 'read')
  const user = requireUser(ctx)
  const rows = await all<PasskeyRow>(ctx.env.DB, 'SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at', user.id)
  return rows.map(toPasskey)
}

export async function renamePasskey(ctx: Ctx, id: string, body: Json): Promise<Passkey> {
  const { user } = requireSessionUser(ctx)
  const name = str(body, 'name', NAME)
  const row = await first<PasskeyRow>(ctx.env.DB, 'UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ? RETURNING *', name, id, user.id)
  if (!row) throw notFound('Passkey not found')
  return toPasskey(row)
}

export async function deletePasskey(ctx: Ctx, id: string): Promise<void> {
  const { user } = requireSessionUser(ctx)
  const exists = await first(ctx.env.DB, 'SELECT 1 AS one FROM passkeys WHERE id = ? AND user_id = ?', id, user.id)
  if (!exists) throw notFound('Passkey not found')
  if ((await signInMethodCount(ctx.env, user.id)) <= 1) {
    throw conflict('This is your only way to sign in. Add a password or another passkey first.', 'last_sign_in_method')
  }
  await run(ctx.env.DB, 'DELETE FROM passkeys WHERE id = ? AND user_id = ?', id, user.id)
  await audit(ctx, null, 'passkey.delete', user.id, { passkeyId: id })
}

export async function listSessions(ctx: Ctx): Promise<SessionInfo[]> {
  const { user, sessionId } = requireSessionUser(ctx)
  const rows = await all<SessionRow>(
    ctx.env.DB,
    'SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
    user.id,
    Date.now(),
  )
  return rows.map((r) => toSession(r, sessionId))
}

export async function deleteSession(ctx: Ctx, id: string): Promise<void> {
  const { user } = requireSessionUser(ctx)
  const row = await first(ctx.env.DB, 'SELECT 1 AS one FROM sessions WHERE id = ? AND user_id = ?', id, user.id)
  if (!row) throw notFound('Session not found')
  await revokeSession(ctx.env, id)
}
