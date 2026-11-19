import type { AccessSubject, PrinterGrant, PrinterPermission, PrinterRole } from '../../../shared/access'
import { BUILT_IN_ROLES } from '../../../shared/access'
import { all, parseJson, stmt } from '../../lib/db'
import { extensionConfig } from '../state'
import type { PolicyData, PolicyGrant } from './policy'

export const EXTENSION = 'printer-access'
/** Everyone's role on printers without their own setting, when a workspace first turns the extension on. */
const INITIAL_DEFAULT_ROLE = 'user'

export interface GrantRow {
  id: string
  printer_id: string | null
  subject_type: AccessSubject['type']
  subject_id: string | null
  role: string
  created_at: number
  subject_name: string | null
}

export interface RoleRow {
  id: string
  name: string
  description: string | null
  permissions: string
  created_at: number
  updated_at: number
}

export const GRANT_VIEW = `SELECT g.id, g.printer_id, g.subject_type, COALESCE(g.user_id, g.group_id, g.client_id) AS subject_id, g.role, g.created_at,
    CASE g.subject_type WHEN 'user' THEN u.name WHEN 'group' THEN gr.name WHEN 'client' THEN c.name END AS subject_name
  FROM printer_grants g
  LEFT JOIN users u ON u.id = g.user_id
  LEFT JOIN groups gr ON gr.id = g.group_id
  LEFT JOIN clients c ON c.id = g.client_id`

export const toSubject = (type: AccessSubject['type'], id: string | null): AccessSubject =>
  type === 'everyone' ? { type } : ({ type, id: id ?? '' } as AccessSubject)

export const toGrant = (r: GrantRow): PrinterGrant => ({
  id: r.id,
  printerId: r.printer_id,
  subject: toSubject(r.subject_type, r.subject_id),
  subjectName: r.subject_type === 'everyone' ? 'Everyone' : (r.subject_name ?? 'Removed'),
  role: r.role,
  createdAt: r.created_at,
})

export const BUILT_IN_ROLE_LIST: PrinterRole[] = Object.entries(BUILT_IN_ROLES).map(([id, r]) => ({
  id,
  name: r.name,
  description: r.description,
  permissions: [...r.permissions],
  builtIn: true,
}))

export const toRole = (r: RoleRow): PrinterRole => ({
  id: r.id,
  name: r.name,
  description: r.description,
  permissions: parseJson<PrinterPermission[]>(r.permissions, []),
  builtIn: false,
})

const defaultRoleIn = (config: Record<string, unknown>): string => (typeof config.defaultRole === 'string' ? config.defaultRole : INITIAL_DEFAULT_ROLE)

export const defaultRole = async (env: Env, workspaceId: string): Promise<string> => defaultRoleIn(await extensionConfig(env, workspaceId, EXTENSION))

export const customRoles = (env: Env, workspaceId: string): Promise<RoleRow[]> =>
  all<RoleRow>(env.DB, 'SELECT * FROM printer_roles WHERE workspace_id = ? ORDER BY name COLLATE NOCASE', workspaceId)

/** Workspace-wide grants (`printerId` null), or one printer's own. */
export const grantRows = (env: Env, workspaceId: string, printerId: string | null): Promise<GrantRow[]> =>
  all<GrantRow>(env.DB, `${GRANT_VIEW} WHERE g.workspace_id = ? AND g.printer_id IS ? ORDER BY g.created_at, g.id`, workspaceId, printerId)

/** One round trip for everything the policy needs. */
export async function loadPolicyData(env: Env, workspaceId: string): Promise<PolicyData> {
  const [config, roles, everyone, grants, members] = await env.DB.batch([
    stmt(env.DB, 'SELECT config FROM workspace_extensions WHERE workspace_id = ? AND extension_id = ?', workspaceId, EXTENSION),
    stmt(env.DB, 'SELECT id, permissions FROM printer_roles WHERE workspace_id = ?', workspaceId),
    stmt(env.DB, 'SELECT printer_id, role FROM printer_everyone WHERE workspace_id = ?', workspaceId),
    stmt(
      env.DB,
      'SELECT id, printer_id, subject_type, COALESCE(user_id, group_id, client_id) AS subject_id, role FROM printer_grants WHERE workspace_id = ? ORDER BY created_at, id',
      workspaceId,
    ),
    stmt(env.DB, "SELECT group_id, member_type || ':' || COALESCE(user_id, client_id) AS member FROM group_members WHERE workspace_id = ?", workspaceId),
  ])
  const groups = new Map<string, Set<string>>()
  for (const m of members.results as { group_id: string; member: string }[]) {
    groups.set(m.member, (groups.get(m.member) ?? new Set()).add(m.group_id))
  }
  return {
    defaultRole: defaultRoleIn(parseJson((config.results[0] as { config: string } | undefined)?.config, {})),
    roles: new Map((roles.results as { id: string; permissions: string }[]).map((r) => [r.id, parseJson<PrinterPermission[]>(r.permissions, [])])),
    everyone: new Map((everyone.results as { printer_id: string; role: string }[]).map((e) => [e.printer_id, e.role])),
    grants: (grants.results as Omit<GrantRow, 'created_at' | 'subject_name'>[]).map(
      (g): PolicyGrant => ({ id: g.id, printerId: g.printer_id, subject: toSubject(g.subject_type, g.subject_id), role: g.role }),
    ),
    groups,
  }
}
