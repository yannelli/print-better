import type { Role } from '../../../shared/types'
import type { UserRow } from '../../db/rows'
import { forbidden } from '../../http/errors'
import { requireScope, type Scope } from '../../services/access'
import { audit } from '../../services/audit'
import type { Ctx } from '../../services/context'
import { notifyHub } from '../../services/hub'
import { memberAccess, type Access } from '../../services/permissions'
import { requireActive } from '../state'
import { EXTENSION } from './store'

export interface Caller {
  user: UserRow
  role: Role
  access: Access
}

/** Every printer-access entry point: token scope, membership, the extension being on, then admin rights when asked. */
export async function enter(ctx: Ctx, workspaceId: string, scope: Scope, admins = false): Promise<Caller> {
  requireScope(ctx, scope)
  const caller = await memberAccess(ctx, workspaceId)
  await requireActive(ctx, workspaceId, EXTENSION)
  if (admins && caller.role === 'member') throw forbidden('Only admins can do that')
  return caller
}

/** Audits a change and tells open pages and devices to refresh. */
export async function changed(ctx: Ctx, workspaceId: string, action: string, target: string, data?: Record<string, unknown>): Promise<void> {
  await audit(ctx, workspaceId, action, target, data)
  notifyHub(ctx, workspaceId, (hub) => hub.accessChanged())
}
