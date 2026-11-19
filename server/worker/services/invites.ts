import type { Invite, Role, WorkspaceSummary } from '../../shared/types'
import { toInvite } from '../db/map'
import type { InviteRow, UserRow } from '../db/rows'
import { inviteMail } from '../email/templates'
import { sendMail } from '../email/outbound'
import type { Json } from '../http/body'
import { conflict, notFound } from '../http/errors'
import { EMAIL, nullableStr, optOneOf } from '../http/validate'
import { newId, newToken, sha256Hex } from '../lib/crypto'
import { all, first, run } from '../lib/db'
import { DAY } from '../lib/time'
import { memberRole, requireMember, requireScope, requireUser } from './access'
import { audit } from './audit'
import type { Ctx } from './context'
import { appName, loadInstance } from './instance-store'

const INVITE_TTL = 7 * DAY

export const inviteUrl = (origin: string, token: string): string => `${origin}/invite/${token}`

export async function listInvites(ctx: Ctx, workspaceId: string): Promise<Invite[]> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId, 'admin')
  const rows = await all<InviteRow>(
    ctx.env.DB,
    'SELECT * FROM invites WHERE workspace_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
    workspaceId,
    Date.now(),
  )
  return rows.map(toInvite)
}

export async function createInvite(ctx: Ctx, workspaceId: string, body: Json): Promise<{ invite: Invite; url: string }> {
  requireScope(ctx, 'write')
  const { user } = await requireMember(ctx, workspaceId, 'admin')
  const role = optOneOf(body, 'role', ['admin', 'member'] as const) ?? 'member'
  const email = nullableStr(body, 'email', EMAIL)?.toLowerCase() ?? null
  const token = newToken('pbi_')
  const now = Date.now()
  const row: InviteRow = {
    id: newId(),
    workspace_id: workspaceId,
    token_hash: await sha256Hex(token),
    role,
    email,
    created_by: user.id,
    created_at: now,
    expires_at: now + INVITE_TTL,
    accepted_by: null,
    accepted_at: null,
  }
  await run(
    ctx.env.DB,
    'INSERT INTO invites (id, workspace_id, token_hash, role, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    row.id,
    row.workspace_id,
    row.token_hash,
    row.role,
    row.email,
    row.created_by,
    row.created_at,
    row.expires_at,
  )
  const url = inviteUrl(ctx.origin, token)
  if (email) ctx.waitUntil(emailInvite(ctx.env, workspaceId, user, row, url).catch((e: unknown) => console.error('invite email failed', e)))
  await audit(ctx, workspaceId, 'invite.create', row.id, { role, email })
  return { invite: toInvite(row), url }
}

async function emailInvite(env: Env, workspaceId: string, inviter: UserRow, invite: InviteRow, url: string): Promise<void> {
  const [inst, ws] = await Promise.all([loadInstance(env), first<{ name: string }>(env.DB, 'SELECT name FROM workspaces WHERE id = ?', workspaceId)])
  if (!invite.email || !ws) return
  await sendMail(
    env,
    inviteMail({ to: invite.email, app: appName(env, inst), workspace: ws.name, inviter: inviter.name, role: invite.role, url, expiresAt: invite.expires_at }),
    inst,
  )
}

export async function deleteInvite(ctx: Ctx, workspaceId: string, inviteId: string): Promise<void> {
  requireScope(ctx, 'write')
  await requireMember(ctx, workspaceId, 'admin')
  const changed = await run(ctx.env.DB, 'DELETE FROM invites WHERE id = ? AND workspace_id = ?', inviteId, workspaceId)
  if (changed === 0) throw notFound('Invite not found')
  await audit(ctx, workspaceId, 'invite.delete', inviteId)
}

/** A pending, unexpired invite for this `pbi_` token, or null. */
export async function findInvite(env: Env, token: string): Promise<InviteRow | null> {
  if (!token.startsWith('pbi_')) return null
  return first<InviteRow>(
    env.DB,
    'SELECT * FROM invites WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?',
    await sha256Hex(token),
    Date.now(),
  )
}

export async function requireInvite(env: Env, token: string): Promise<InviteRow> {
  const invite = await findInvite(env, token)
  if (!invite) throw notFound('This invite is invalid, used, or expired', 'invite_invalid')
  return invite
}

export async function previewInvite(ctx: Ctx, token: string): Promise<{ workspaceName: string; inviterName: string | null; role: Role; expiresAt: number }> {
  const invite = await requireInvite(ctx.env, token)
  const row = await first<{ name: string; inviter: string | null }>(
    ctx.env.DB,
    'SELECT w.name, (SELECT name FROM users WHERE id = ?) AS inviter FROM workspaces w WHERE w.id = ?',
    invite.created_by,
    invite.workspace_id,
  )
  if (!row) throw notFound('This invite is invalid, used, or expired', 'invite_invalid')
  return { workspaceName: row.name, inviterName: row.inviter, role: invite.role as Role, expiresAt: invite.expires_at }
}

/** Joins the workspace; an existing member keeps their role and the invite stays unused. */
export async function joinWithInvite(ctx: Ctx, invite: InviteRow, userId: string): Promise<WorkspaceSummary> {
  const ws = await first<{ name: string }>(ctx.env.DB, 'SELECT name FROM workspaces WHERE id = ?', invite.workspace_id)
  if (!ws) throw notFound('This invite is invalid, used, or expired', 'invite_invalid')
  const existing = await memberRole(ctx.env.DB, invite.workspace_id, userId)
  if (existing) return { id: invite.workspace_id, name: ws.name, role: existing }
  const now = Date.now()
  const consumed = await run(
    ctx.env.DB,
    'UPDATE invites SET accepted_by = ?, accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND expires_at > ?',
    userId,
    now,
    invite.id,
    now,
  )
  if (consumed === 0) throw conflict('This invite was already used', 'invite_invalid')
  await run(ctx.env.DB, 'INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', invite.workspace_id, userId, invite.role, now)
  await audit(ctx, invite.workspace_id, 'invite.accept', invite.id, { userId, role: invite.role })
  return { id: invite.workspace_id, name: ws.name, role: invite.role as Role }
}

export async function acceptInvite(ctx: Ctx, token: string): Promise<WorkspaceSummary> {
  requireScope(ctx, 'write')
  const user = requireUser(ctx)
  return joinWithInvite(ctx, await requireInvite(ctx.env, token), user.id)
}
