// How access is decided (docs/printer-access.md). Pure: no I/O, so every rule is unit tested.

import {
  BUILT_IN_ROLES,
  NO_ACCESS,
  PRINTER_PERMISSIONS,
  withImplied,
  type AccessExplanation,
  type AccessSubject,
  type BuiltInPrinterRole,
  type PrinterPermission,
} from '../../../shared/access'
import type { AccessPrincipal } from '../hooks'

export interface PolicyGrant {
  id: string
  /** Null: every printer in the workspace. */
  printerId: string | null
  subject: AccessSubject
  role: string
}

/** Everything that decides printer access in one workspace. */
export interface PolicyData {
  defaultRole: string
  /** Custom role id to its permissions. */
  roles: ReadonlyMap<string, readonly PrinterPermission[]>
  /** Printers with their own Everyone role. */
  everyone: ReadonlyMap<string, string>
  grants: readonly PolicyGrant[]
  /** `user:<id>` or `client:<id>` to the groups it belongs to. */
  groups: ReadonlyMap<string, ReadonlySet<string>>
}

const NONE: ReadonlySet<string> = new Set()

export const isBuiltInRole = (role: string): role is BuiltInPrinterRole => Object.hasOwn(BUILT_IN_ROLES, role)

export function rolePermissions(data: PolicyData, role: string): readonly PrinterPermission[] {
  if (role === NO_ACCESS) return []
  return isBuiltInRole(role) ? BUILT_IN_ROLES[role].permissions : (data.roles.get(role) ?? [])
}

/** The printer's own Everyone role, else the workspace default. */
export const everyoneRole = (data: PolicyData, printerId: string): string => data.everyone.get(printerId) ?? data.defaultRole

const isWorkspaceAdmin = (p: AccessPrincipal): p is Extract<AccessPrincipal, { kind: 'member' }> => p.kind === 'member' && p.role !== 'member'

function groupsOf(data: PolicyData, p: AccessPrincipal): ReadonlySet<string> {
  if (p.kind === 'member') return data.groups.get(`user:${p.userId}`) ?? NONE
  if (p.kind === 'device') return data.groups.get(`client:${p.clientId}`) ?? NONE
  return p.kind === 'group' ? new Set([p.groupId]) : NONE
}

function matches(subject: AccessSubject, p: AccessPrincipal, groups: ReadonlySet<string>): boolean {
  switch (subject.type) {
    case 'everyone':
      return true
    case 'user':
      return p.kind === 'member' && p.userId === subject.id
    case 'client':
      return p.kind === 'device' && p.clientId === subject.id
    case 'group':
      return groups.has(subject.id)
  }
}

/** The grants that can apply to `principal` anywhere; which of them apply to a printer is decided per printer. */
const grantsFor = (data: PolicyData, principal: AccessPrincipal): PolicyGrant[] => {
  const groups = groupsOf(data, principal)
  return data.grants.filter((g) => matches(g.subject, principal, groups))
}

const onPrinter = (grants: PolicyGrant[], printerId: string) => grants.filter((g) => g.printerId === null || g.printerId === printerId)

/** Why `principal` has what it has on `printerId`. Owners and admins always get everything. */
export function explain(data: PolicyData, principal: AccessPrincipal, printerId: string): AccessExplanation {
  if (isWorkspaceAdmin(principal)) return { permissions: [...PRINTER_PERMISSIONS], sources: [{ kind: 'workspace-role', role: principal.role }] }
  const sources: AccessExplanation['sources'] = []
  const everyone = everyoneRole(data, printerId)
  if (rolePermissions(data, everyone).length > 0) sources.push({ kind: 'everyone', role: everyone })
  for (const g of onPrinter(grantsFor(data, principal), printerId)) sources.push({ kind: 'grant', role: g.role, grantId: g.id, via: g.subject })
  return { permissions: withImplied(sources.flatMap((s) => rolePermissions(data, s.role))), sources }
}

/** Same answer as `explain`, for many printers: grants are matched once and results kept per printer. */
export function evaluator(data: PolicyData, principal: AccessPrincipal): (printerId: string) => readonly PrinterPermission[] {
  if (isWorkspaceAdmin(principal)) return () => PRINTER_PERMISSIONS
  const mine = grantsFor(data, principal)
  const seen = new Map<string, readonly PrinterPermission[]>()
  return (printerId) => {
    let perms = seen.get(printerId)
    if (!perms) {
      const roles = [everyoneRole(data, printerId), ...onPrinter(mine, printerId).map((g) => g.role)]
      perms = withImplied(roles.flatMap((role) => rolePermissions(data, role)))
      seen.set(printerId, perms)
    }
    return perms
  }
}
