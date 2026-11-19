import type { User } from '../../shared/types'
import { toUser } from '../db/map'
import type { UserRow } from '../db/rows'
import type { Json } from '../http/body'
import { conflict, notFound } from '../http/errors'
import { optBool } from '../http/validate'
import { all, first, run } from '../lib/db'
import { DAY } from '../lib/time'
import { requireInstanceAdmin, requireScope } from './access'
import { issueResetToken, resetUrl } from './accounts'
import { audit } from './audit'
import type { Ctx } from './context'
import { getUser } from './users'

const KEEPS_AN_ADMIN = '(is_admin = 0 OR (SELECT COUNT(*) FROM users WHERE is_admin = 1) > 1)'

async function loadUser(env: Env, id: string): Promise<UserRow> {
  const user = await getUser(env, id)
  if (!user) throw notFound('User not found')
  return user
}

export async function listUsers(ctx: Ctx): Promise<User[]> {
  requireScope(ctx, 'read')
  requireInstanceAdmin(ctx)
  return (await all<UserRow>(ctx.env.DB, 'SELECT * FROM users ORDER BY created_at')).map(toUser)
}

export async function patchUser(ctx: Ctx, id: string, body: Json): Promise<User> {
  requireScope(ctx, 'write')
  requireInstanceAdmin(ctx)
  const isAdmin = optBool(body, 'isAdmin')
  const user = await loadUser(ctx.env, id)
  if (isAdmin !== undefined && isAdmin !== (user.is_admin === 1)) {
    const changed = await run(ctx.env.DB, `UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ? AND ${KEEPS_AN_ADMIN}`, isAdmin, Date.now(), id)
    if (changed === 0) throw conflict('The server needs at least one administrator', 'last_admin')
    await audit(ctx, null, 'user.update', id, { isAdmin })
  }
  return toUser(await loadUser(ctx.env, id))
}

/** Refuses while the user is the sole owner of a workspace, so no workspace is left without an owner. */
export async function deleteUser(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write')
  requireInstanceAdmin(ctx)
  const user = await loadUser(ctx.env, id)
  const soleOwner = await first<{ name: string }>(
    ctx.env.DB,
    `SELECT w.name FROM members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? AND m.role = 'owner'
       AND (SELECT COUNT(*) FROM members o WHERE o.workspace_id = m.workspace_id AND o.role = 'owner') = 1 LIMIT 1`,
    id,
  )
  if (soleOwner) throw conflict(`${user.name} is the only owner of "${soleOwner.name}". Transfer or delete it first.`, 'sole_owner')
  const changed = await run(ctx.env.DB, `DELETE FROM users WHERE id = ? AND ${KEEPS_AN_ADMIN}`, id)
  if (changed === 0) throw conflict('The server needs at least one administrator', 'last_admin')
  await audit(ctx, null, 'user.delete', id, { username: user.username })
}

/** One-time link (24 h) the admin hands to the user out of band. */
export async function adminResetLink(ctx: Ctx, id: string): Promise<{ url: string }> {
  requireScope(ctx, 'write')
  requireInstanceAdmin(ctx)
  await loadUser(ctx.env, id)
  const token = await issueResetToken(ctx.env, id, DAY, null)
  await audit(ctx, null, 'reset.create', id)
  return { url: resetUrl(ctx.origin, token) }
}
