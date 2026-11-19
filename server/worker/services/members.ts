import type { Member, Role } from '../../shared/types'
import { toMember } from '../db/map'
import type { Json } from '../http/body'
import { conflict, forbidden, notFound } from '../http/errors'
import { oneOf } from '../http/validate'
import { all, first, run } from '../lib/db'
import { requireMember, requireScope, requireUser } from './access'
import { audit } from './audit'
import type { Ctx } from './context'
import { notifyHub } from './hub'

type MemberView = { user_id: string; username: string; name: string; email: string | null; role: string; created_at: number }

const MEMBER_VIEW = `SELECT m.user_id, m.role, m.created_at, u.username, u.name, u.email
  FROM members m JOIN users u ON u.id = m.user_id`

// Demoting or removing an owner only succeeds while another owner remains; enforced inside the write itself.
const KEEPS_AN_OWNER = `(role != 'owner' OR (SELECT COUNT(*) FROM members WHERE workspace_id = ? AND role = 'owner') > 1)`

export async function listMembers(ctx: Ctx, workspaceId: string): Promise<Member[]> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId)
  const rows = await all<MemberView>(ctx.env.DB, `${MEMBER_VIEW} WHERE m.workspace_id = ? ORDER BY m.created_at`, workspaceId)
  return rows.map(toMember)
}

async function loadMember(env: Env, workspaceId: string, userId: string): Promise<MemberView> {
  const row = await first<MemberView>(env.DB, `${MEMBER_VIEW} WHERE m.workspace_id = ? AND m.user_id = ?`, workspaceId, userId)
  if (!row) throw notFound('Member not found')
  return row
}

export async function updateMemberRole(ctx: Ctx, workspaceId: string, userId: string, body: Json): Promise<Member> {
  requireScope(ctx, 'write')
  const { role: actorRole } = await requireMember(ctx, workspaceId, 'admin')
  const role = oneOf(body, 'role', ['owner', 'admin', 'member'] as const)
  const target = await loadMember(ctx.env, workspaceId, userId)
  if (target.role === role) return toMember(target)
  if ((role === 'owner' || target.role === 'owner') && actorRole !== 'owner') throw forbidden('Only owners can grant or revoke ownership')
  const changed = await run(
    ctx.env.DB,
    `UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ? AND ${KEEPS_AN_OWNER}`,
    role,
    workspaceId,
    userId,
    workspaceId,
  )
  if (changed === 0) throw conflict('A workspace needs at least one owner', 'last_owner')
  await audit(ctx, workspaceId, 'member.update', userId, { from: target.role, to: role })
  notifyHub(ctx, workspaceId, (hub) => hub.broadcastWorkspace(workspaceId))
  return toMember({ ...target, role })
}

/** Admins remove others; anyone may leave. Owners can only be removed by owners. */
export async function removeMember(ctx: Ctx, workspaceId: string, userId: string): Promise<void> {
  requireScope(ctx, 'write')
  const self = requireUser(ctx)
  const leaving = self.id === userId
  const { role: actorRole } = await requireMember(ctx, workspaceId, leaving ? 'member' : 'admin')
  const target = await loadMember(ctx.env, workspaceId, userId)
  if ((target.role as Role) === 'owner' && !leaving && actorRole !== 'owner') throw forbidden('Only owners can remove an owner')
  const changed = await run(ctx.env.DB, `DELETE FROM members WHERE workspace_id = ? AND user_id = ? AND ${KEEPS_AN_OWNER}`, workspaceId, userId, workspaceId)
  if (changed === 0) throw conflict('A workspace needs at least one owner', 'last_owner')
  await audit(ctx, workspaceId, leaving ? 'member.leave' : 'member.remove', userId)
  notifyHub(ctx, workspaceId, (hub) => hub.disconnect({ userId }, 4401, 'Removed from workspace'))
}
