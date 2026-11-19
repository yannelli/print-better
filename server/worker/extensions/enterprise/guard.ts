import type { EnterpriseSettings } from '../../../shared/enterprise'
import type { Role } from '../../../shared/types'
import type { UserRow } from '../../db/rows'
import { conflict, forbidden } from '../../http/errors'
import { requireScope, type Scope } from '../../services/access'
import { audit } from '../../services/audit'
import type { Ctx } from '../../services/context'
import { notifyHub } from '../../services/hub'
import { memberAccess, type Access } from '../../services/permissions'
import { requireActive } from '../state'
import { EXTENSION, settingsOf } from './store'

export type Part = keyof EnterpriseSettings

const PART_NAMES: Record<Part, string> = {
  approvals: 'Approvals',
  release: 'Secure release',
  costCenters: 'Cost centers',
  reports: 'Reports',
  alerts: 'Alerts',
  privacy: 'Retention and privacy',
}

export interface Caller {
  user: UserRow
  role: Role
  access: Access
  settings: EnterpriseSettings
}

export const isAdmin = (role: Role): boolean => role !== 'member'

/** Every entry point: token scope, membership, the extension being on, its part being on, then the role when asked. */
export async function enter(ctx: Ctx, workspaceId: string, scope: Scope, part: Part | null, min: 'member' | 'admin' | 'owner' = 'member'): Promise<Caller> {
  requireScope(ctx, scope)
  const caller = await memberAccess(ctx, workspaceId)
  await requireActive(ctx, workspaceId, EXTENSION)
  const settings = await settingsOf(ctx, workspaceId)
  if (part) requirePart(settings, part)
  if (min === 'admin' && !isAdmin(caller.role)) throw forbidden('Only admins can do that')
  if (min === 'owner' && caller.role !== 'owner') throw forbidden('Only owners can do that')
  return { ...caller, settings }
}

export function requirePart(settings: EnterpriseSettings, part: Part): void {
  if (settings[part].enabled) return
  throw conflict(`${PART_NAMES[part]} is turned off. An admin turns it on under Workspace settings > Enterprise.`, 'part_off')
}

/** Audits a change and tells open pages to refetch: `access` for settings, `usage` for budgets. */
export async function changed(ctx: Ctx, workspaceId: string, action: string, target: string | null, data?: Record<string, unknown>, event: 'access' | 'usage' = 'access'): Promise<void> {
  await audit(ctx, workspaceId, action, target, data)
  notifyHub(ctx, workspaceId, (hub) => (event === 'access' ? hub.accessChanged() : hub.broadcast([{ type: 'usage' }])))
}
