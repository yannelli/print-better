import type { Role } from '../../shared/types'
import type { UserRow } from '../db/rows'
import { forbidden, notFound, unauthorized } from '../http/errors'
import { first } from '../lib/db'
import { actingUser, type Ctx } from './context'

const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 }

export const roleAtLeast = (role: Role, min: Role): boolean => RANK[role] >= RANK[min]

/** Token permissions: read = gets and lists, print = jobs and test pages, write = every other change. */
export const SCOPES = ['read', 'write', 'print'] as const
export type Scope = (typeof SCOPES)[number]

/** Sessions, devices and the system act with every scope; tokens only with what they were granted ("*", the column default, is all). */
export const hasScope = (ctx: Ctx, scope: Scope): boolean =>
  ctx.actor.type !== 'token' || ctx.actor.scopes.includes(scope) || ctx.actor.scopes.includes('*')

export function requireScope(ctx: Ctx, scope: Scope): void {
  if (!hasScope(ctx, scope)) throw forbidden(`This token does not have the "${scope}" permission`, 'insufficient_scope')
}

/** A signed-in user acting through a session or an API/OAuth token. */
export function requireUser(ctx: Ctx): UserRow {
  const user = actingUser(ctx)
  if (!user) throw unauthorized()
  return user
}

/** Account-security operations (passwords, passkeys, sessions, tokens) need a browser session, not a token. */
export function requireSessionUser(ctx: Ctx): { user: UserRow; sessionId: string } {
  if (ctx.actor.type === 'user') return { user: ctx.actor.user, sessionId: ctx.actor.sessionId }
  if (ctx.actor.type === 'token') throw forbidden('This action needs a signed-in browser session', 'session_required')
  throw unauthorized()
}

export function requireInstanceAdmin(ctx: Ctx): UserRow {
  const user = requireUser(ctx)
  if (user.is_admin !== 1) throw forbidden('Instance administrators only')
  return user
}

export async function memberRole(db: D1Database, workspaceId: string, userId: string): Promise<Role | null> {
  const row = await first<{ role: Role }>(db, 'SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId)
  return row?.role ?? null
}

/** Workspaces the actor cannot see are reported as missing, not forbidden. */
export async function requireMember(ctx: Ctx, workspaceId: string, min: Role = 'member'): Promise<{ user: UserRow; role: Role }> {
  const user = requireUser(ctx)
  if (ctx.actor.type === 'token' && ctx.actor.workspaceId && ctx.actor.workspaceId !== workspaceId) {
    throw notFound('Workspace not found')
  }
  const role = await memberRole(ctx.env.DB, workspaceId, user.id)
  if (!role) throw notFound('Workspace not found')
  if (!roleAtLeast(role, min)) throw forbidden(min === 'owner' ? 'Only owners can do that' : 'Only admins can do that')
  return { user, role }
}
