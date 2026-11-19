import { NO_ACCESS, type AccessExplanation, type PrinterAccessSummary, type PrinterPermission, type WorkspaceAccess } from '../../../shared/access'
import type { Json } from '../../http/body'
import { badRequest, notFound } from '../../http/errors'
import { all, first } from '../../lib/db'
import { requireMember, requireScope } from '../../services/access'
import type { Ctx } from '../../services/context'
import { accessFrom, policyFor, requirePermission } from '../../services/permissions'
import { extensionConfig, saveExtensionConfig } from '../state'
import { changed, enter } from './guard'
import { everyoneRole, explain } from './policy'
import { BUILT_IN_ROLE_LIST, customRoles, defaultRole, EXTENSION, grantRows, loadPolicyData, toGrant, toRole } from './store'
import { parseRole, principalOf, subjectFrom, subjectParam } from './values'

export async function workspaceAccess(env: Env, workspaceId: string): Promise<WorkspaceAccess> {
  const [role, roles, grants] = await Promise.all([defaultRole(env, workspaceId), customRoles(env, workspaceId), grantRows(env, workspaceId, null)])
  return { defaultRole: role, roles: [...BUILT_IN_ROLE_LIST, ...roles.map(toRole)], grants: grants.map(toGrant) }
}

export async function getWorkspaceAccess(ctx: Ctx, workspaceId: string): Promise<WorkspaceAccess> {
  await enter(ctx, workspaceId, 'read')
  return workspaceAccess(ctx.env, workspaceId)
}

/** The role Everyone gets on printers without their own setting (`none` restricts all of them). */
export async function setDefaultRole(ctx: Ctx, workspaceId: string, body: Json): Promise<WorkspaceAccess> {
  await enter(ctx, workspaceId, 'write', true)
  const role = await parseRole(ctx.env, workspaceId, body.defaultRole, 'defaultRole', true)
  if ((await defaultRole(ctx.env, workspaceId)) !== role) {
    const config = await extensionConfig(ctx.env, workspaceId, EXTENSION)
    await saveExtensionConfig(ctx.env, workspaceId, EXTENSION, { ...config, defaultRole: role })
    await changed(ctx, workspaceId, 'access.update', workspaceId, { defaultRole: role })
  }
  return workspaceAccess(ctx.env, workspaceId)
}

/** One row per printer the caller can see, for lock icons in lists. */
export async function printerSummaries(ctx: Ctx, workspaceId: string): Promise<PrinterAccessSummary[]> {
  const { access } = await enter(ctx, workspaceId, 'read')
  const [data, printers] = await Promise.all([
    loadPolicyData(ctx.env, workspaceId),
    all<{ id: string }>(ctx.env.DB, 'SELECT id FROM printers WHERE workspace_id = ? ORDER BY added DESC, name COLLATE NOCASE', workspaceId),
  ])
  return printers
    .filter((p) => access.can(p.id, 'view'))
    .map((p) => {
      const role = everyoneRole(data, p.id)
      return { printerId: p.id, effectiveEveryoneRole: role, restricted: role === NO_ACCESS, grants: data.grants.filter((g) => g.printerId === p.id).length }
    })
}

/** Admins, or anyone who may change who can use the printer. */
export async function explainAccess(ctx: Ctx, workspaceId: string, printerId: string | null, subject: unknown): Promise<AccessExplanation> {
  const { access } = await enter(ctx, workspaceId, 'read')
  if (!printerId) throw badRequest('printer is required')
  const printer = await first<{ id: string }>(ctx.env.DB, 'SELECT id FROM printers WHERE id = ? AND workspace_id = ?', printerId, workspaceId)
  if (!printer) throw notFound('Printer not found')
  requirePermission(access, printer.id, 'access')
  const principal = await principalOf(ctx.env, workspaceId, subjectFrom(subject))
  return explain(await loadPolicyData(ctx.env, workspaceId), principal, printer.id)
}

/** A subject's permissions on every printer; answers with today's rules while the extension is off. */
export async function subjectAccess(ctx: Ctx, workspaceId: string, subject: string | null): Promise<{ printers: Record<string, PrinterPermission[]> }> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId, 'admin')
  const principal = await principalOf(ctx.env, workspaceId, subjectParam(subject))
  const policy = await policyFor(ctx, workspaceId)
  const access = accessFrom(policy, principal)
  const rows = await all<{ id: string; client_id: string; added: number }>(ctx.env.DB, 'SELECT id, client_id, added FROM printers WHERE workspace_id = ?', workspaceId)
  // Without the extension a device's print window offers exactly the added printers of other devices.
  const legacyDevice = !policy && principal.kind === 'device'
  const printers: Record<string, PrinterPermission[]> = {}
  for (const p of rows) {
    const perms: readonly PrinterPermission[] = legacyDevice ? (p.added === 1 && p.client_id !== principal.clientId ? ['view', 'print'] : []) : access.permissions(p.id)
    if (perms.length > 0) printers[p.id] = [...perms]
  }
  return { printers }
}
