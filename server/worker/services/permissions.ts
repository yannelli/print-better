import { LEGACY_MEMBER_PERMISSIONS, PRINTER_PERMISSIONS, type MyPrinterAccess, type PrinterPermission } from '../../shared/access'
import type { Role } from '../../shared/types'
import type { ClientRow, UserRow } from '../db/rows'
import { printerPolicy, type AccessPrincipal, type PrinterPolicy } from '../extensions/hooks'
import { isActive } from '../extensions/state'
import { forbidden, notFound } from '../http/errors'
import { all } from '../lib/db'
import { requireMember, requireScope } from './access'
import { memo, type Ctx } from './context'

/** What one actor may do with a workspace's printers. Every printer and job decision goes through this. */
export interface Access {
  /** An extension (printer access) decides; otherwise today's role rules apply. */
  managed: boolean
  /** Every permission on every printer: owners, admins and the system. */
  all: boolean
  /** Empty means the printer does not exist for this actor. */
  permissions(printerId: string | null): readonly PrinterPermission[]
  can(printerId: string | null, perm: PrinterPermission): boolean
}

const DENIED: Record<PrinterPermission, string> = {
  view: "You can't see this printer",
  print: "You don't have permission to print to this printer",
  'jobs.read': "You don't have permission to see other people's jobs on this printer",
  'jobs.manage': "You don't have permission to manage other people's jobs on this printer",
  settings: "You don't have permission to change this printer's settings",
  access: "You don't have permission to change who can use this printer",
}

/** With no policy, members, devices and allowlisted senders keep today's access on every printer. */
export function accessFrom(policy: PrinterPolicy | null, principal: AccessPrincipal | 'system'): Access {
  const all = principal === 'system' || (principal.kind === 'member' && principal.role !== 'member')
  const permissions = (printerId: string | null): readonly PrinterPermission[] => {
    if (all) return PRINTER_PERMISSIONS
    if (!policy) return LEGACY_MEMBER_PERMISSIONS
    return printerId === null ? [] : policy.permissions(principal, printerId)
  }
  return { managed: policy !== null, all, permissions, can: (printerId, perm) => permissions(printerId).includes(perm) }
}

/** The active extension's policy for the workspace (null while none is), loaded once per request. */
export const policyFor = (ctx: Ctx, workspaceId: string): Promise<PrinterPolicy | null> =>
  memo(ctx, `printer-policy:${workspaceId}`, () => printerPolicy(ctx.env, workspaceId, (id) => isActive(ctx, workspaceId, id)))

export const accessFor = async (ctx: Ctx, workspaceId: string, principal: AccessPrincipal | 'system'): Promise<Access> =>
  accessFrom(await policyFor(ctx, workspaceId), principal)

export const deviceAccess = (ctx: Ctx, client: ClientRow): Promise<Access> => accessFor(ctx, client.workspace_id, { kind: 'device', clientId: client.id })

/** requireMember plus printer access. Without an extension, a member lacking `need` is refused
 *  here, before any lookup, exactly as the old admin-only checks did. */
export async function memberAccess(ctx: Ctx, workspaceId: string, need?: PrinterPermission): Promise<{ user: UserRow; role: Role; access: Access }> {
  const { user, role } = await requireMember(ctx, workspaceId)
  const access = await accessFor(ctx, workspaceId, { kind: 'member', userId: user.id, role })
  if (need && !access.managed && !access.can(null, need)) throw forbidden('Only admins can do that')
  return { user, role, access }
}

/** 404 when the printer does not exist for this actor (no `view`), 403 when it does but `perm` is missing. */
export function requirePermission(access: Access, printerId: string, perm: PrinterPermission): void {
  if (access.can(printerId, perm)) return
  if (!access.can(printerId, 'view')) throw notFound('Printer not found')
  throw forbidden(DENIED[perm], 'printer_access_denied')
}

/** `GET /workspaces/:ws/access/me`: the caller's permissions per printer, with or without the extension. */
export async function myPrinterAccess(ctx: Ctx, workspaceId: string): Promise<MyPrinterAccess> {
  requireScope(ctx, 'read')
  const { access } = await memberAccess(ctx, workspaceId)
  const printers = await all<{ id: string }>(ctx.env.DB, 'SELECT id FROM printers WHERE workspace_id = ?', workspaceId)
  const entries = printers.map((p): [string, PrinterPermission[]] => [p.id, [...access.permissions(p.id)]]).filter(([, perms]) => perms.length > 0)
  return { managed: access.managed, all: access.all, printers: Object.fromEntries(entries) }
}
