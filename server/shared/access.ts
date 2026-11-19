/** Printer access (docs/printer-access.md): what a person or device may do with each printer. */
export type PrinterPermission = 'view' | 'print' | 'jobs.read' | 'jobs.manage' | 'settings' | 'access'

export const PRINTER_PERMISSIONS: readonly PrinterPermission[] = ['view', 'print', 'jobs.read', 'jobs.manage', 'settings', 'access']

/** Every permission other than `view` includes `view`; `jobs.manage` includes `jobs.read`. */
export function withImplied(perms: Iterable<PrinterPermission>): PrinterPermission[] {
  const set = new Set(perms)
  if (set.size > 0) set.add('view')
  if (set.has('jobs.manage')) set.add('jobs.read')
  return PRINTER_PERMISSIONS.filter((p) => set.has(p))
}

export type BuiltInPrinterRole = 'viewer' | 'user' | 'manager'

export const BUILT_IN_ROLES: Record<BuiltInPrinterRole, { name: string; description: string; permissions: readonly PrinterPermission[] }> = {
  viewer: { name: 'Viewer', description: 'Sees the printer and its status', permissions: ['view'] },
  user: { name: 'User', description: "Prints and sees the printer's jobs", permissions: ['view', 'print', 'jobs.read'] },
  manager: { name: 'Manager', description: 'Everything, including settings and who has access', permissions: PRINTER_PERMISSIONS },
}

/** `role` values: a built-in key, a custom role id, or `none` (no access; restricts a printer when used for Everyone). */
export const NO_ACCESS = 'none'

/** With the extension off: members get today's access on every printer, owners and admins get everything. */
export const LEGACY_MEMBER_PERMISSIONS: readonly PrinterPermission[] = BUILT_IN_ROLES.user.permissions

export interface PrinterRole {
  /** `viewer`, `user`, `manager`, or a custom role id. */
  id: string
  name: string
  description: string | null
  permissions: PrinterPermission[]
  builtIn: boolean
}

/** Everyone = every member and every device of the workspace. Groups hold members and devices. */
export type AccessSubject = { type: 'everyone' } | { type: 'user'; id: string } | { type: 'group'; id: string } | { type: 'client'; id: string }

export interface PrinterGrant {
  id: string
  /** `null`: every printer in the workspace. */
  printerId: string | null
  subject: AccessSubject
  /** Display name: member name, group name, or device name. */
  subjectName: string
  role: string
  createdAt: number
}

export type GroupMember = { type: 'user'; id: string; name: string } | { type: 'client'; id: string; name: string }

export interface Group {
  id: string
  name: string
  description: string | null
  members: GroupMember[]
  createdAt: number
  updatedAt: number
}

/** `GET /api/workspaces/:ws/access` */
export interface WorkspaceAccess {
  /** The role Everyone gets on printers that don't set their own. `user` when the extension is first turned on. */
  defaultRole: string
  /** Built-ins first, then custom roles by name. */
  roles: PrinterRole[]
  /** Workspace-wide grants (`printerId: null`). */
  grants: PrinterGrant[]
}

/** `GET /api/workspaces/:ws/printers/:id/access` */
export interface PrinterAccess {
  printerId: string
  /** Everyone's role on this printer; `null` follows the workspace default, `none` restricts it. */
  everyoneRole: string | null
  /** `everyoneRole ?? defaultRole`. */
  effectiveEveryoneRole: string
  grants: PrinterGrant[]
  /** Workspace-wide grants, which apply to this printer too. */
  inherited: PrinterGrant[]
}

/** `GET /api/workspaces/:ws/access/printers`: one row per printer, for lock icons in lists. */
export interface PrinterAccessSummary {
  printerId: string
  effectiveEveryoneRole: string
  restricted: boolean
  grants: number
}

/** `GET /api/workspaces/:ws/access/me`: always available, also with the extension off. */
export interface MyPrinterAccess {
  /** The extension is active in this workspace. */
  managed: boolean
  /** Owner or admin: every permission on every printer. */
  all: boolean
  /** Printer id to the caller's effective permissions; printers they can't see are absent. */
  printers: Record<string, PrinterPermission[]>
}

/** `GET /api/workspaces/:ws/access/explain?printer=<id>&subject=<type>:<id>`: why someone has the access they have. */
export interface AccessExplanation {
  permissions: PrinterPermission[]
  sources: { kind: 'workspace-role' | 'everyone' | 'grant'; role: string; grantId?: string; via?: AccessSubject }[]
}
