import { PRINTER_PERMISSIONS, type PrinterGrant } from '../../../shared/access'
import { badRequest } from '../../http/errors'
import { optStr, str } from '../../http/validate'
import { ACTION, choice, inWorkspace, nullableText, object, output, pick, READ, REMOVE, text, UPDATE, workspaceOf, type Schema, type Tool } from '../../mcp/tool'
import { getPrinterAccess, grantPrinterAccess, grantWorkspaceAccess, revokeGrant, setEveryoneRole } from './grants'
import { createRole, deleteRole, listRoles, updateRole } from './roles'
import { explainAccess, getWorkspaceAccess, setDefaultRole } from './settings'
import { groupTools } from './tools-groups'

const PRINTER_ID = text('Printer id, from list_printers')
const ROLE_ID = text('Custom role id, from list_printer_roles')
const ROLE = text('Role id: viewer, user, manager, or a custom role id from list_printer_roles')
const PERMISSIONS: Schema = {
  type: 'array',
  items: { type: 'string', enum: [...PRINTER_PERMISSIONS] },
  description: 'view, print, jobs.read (everyone’s jobs), jobs.manage, settings, access (who can use it); view is always included',
}
const SUBJECT = object(
  { type: choice('everyone, a member (user), a group, or a device (client)', ['everyone', 'user', 'group', 'client']), id: text('User, group or device id; omit for everyone') },
  ['type'],
  'Who the access is for',
)
const printerIdOf = (args: Record<string, unknown>) => optStr(args, 'printerId', { max: 64 }) ?? null
const roleIdOf = (args: Record<string, unknown>) => str(args, 'roleId', { max: 64 })
const grantLine = (g: PrinterGrant) => `${g.subjectName}: ${g.role}${g.printerId ? '' : ' on every printer'}`

const accessTools: Tool[] = [
  {
    name: 'list_printer_roles',
    title: 'List printer roles',
    description: 'Built-in roles (viewer, user, manager) and custom roles, with their permissions. Needs the printer access extension.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const roles = await listRoles(ctx, await workspaceOf(ctx, args))
      return output(roles.map((r) => `${r.name} (${r.id}): ${r.permissions.join(', ')}`).join('\n'), { roles })
    },
  },
  {
    name: 'create_printer_role',
    title: 'Create printer role',
    description: 'Creates a custom role from any of the six permissions, for example "Prints, sees only own jobs" with view and print. Admins and owners only.',
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace({ name: text('Role name, unique in the workspace'), description: nullableText('What the role is for'), permissions: PERMISSIONS }, ['name', 'permissions']),
    run: async (ctx, args) => {
      const role = await createRole(ctx, await workspaceOf(ctx, args), pick(args, ['name', 'description', 'permissions']))
      return output(`Created role ${role.name} (${role.id}): ${role.permissions.join(', ')}.`, { role })
    },
  },
  {
    name: 'update_printer_role',
    title: 'Update printer role',
    description: 'Renames a custom role or changes its permissions; everyone holding it changes at once. Admins and owners only.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ roleId: ROLE_ID, name: text('New name'), description: nullableText('New description; null clears it'), permissions: PERMISSIONS }, ['roleId']),
    run: async (ctx, args) => {
      const role = await updateRole(ctx, await workspaceOf(ctx, args), roleIdOf(args), pick(args, ['name', 'description', 'permissions']))
      return output(`Updated role ${role.name}: ${role.permissions.join(', ')}.`, { role })
    },
  },
  {
    name: 'delete_printer_role',
    title: 'Delete printer role',
    description: 'Deletes a custom role that no grant, printer or workspace default uses. Admins and owners only.',
    scope: 'write',
    annotations: REMOVE,
    inputSchema: inWorkspace({ roleId: ROLE_ID }, ['roleId']),
    run: async (ctx, args) => {
      const id = roleIdOf(args)
      await deleteRole(ctx, await workspaceOf(ctx, args), id)
      return output(`Deleted role ${id}.`, { removed: id })
    },
  },
  {
    name: 'get_printer_access',
    title: 'Get printer access',
    description: "Who can use a printer: its Everyone role and grants, plus grants on every printer. Without printerId: the workspace default role, roles and workspace-wide grants.",
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace({ printerId: text('Printer id; omit for the whole workspace') }),
    run: async (ctx, args) => {
      const ws = await workspaceOf(ctx, args)
      const printerId = printerIdOf(args)
      if (!printerId) {
        const access = await getWorkspaceAccess(ctx, ws)
        return output([`Default role for Everyone: ${access.defaultRole}`, ...access.grants.map(grantLine)].join('\n'), { access })
      }
      const access = await getPrinterAccess(ctx, ws, printerId)
      return output([`Everyone: ${access.effectiveEveryoneRole}${access.everyoneRole === null ? ' (workspace default)' : ''}`, ...[...access.grants, ...access.inherited].map(grantLine)].join('\n'), { access })
    },
  },
  {
    name: 'set_printer_everyone_role',
    title: 'Set Everyone role',
    description:
      'Sets the role every member and device gets on a printer: a role id, "none" to restrict it to owners, admins and grants, or null to follow the workspace default. Without printerId it sets the workspace default (a role or "none"). Needs access on the printer; the default needs an admin.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ printerId: text('Printer id; omit to set the workspace default'), role: { type: ['string', 'null'], description: 'Role id, "none", or null (printers only)' } }),
    run: async (ctx, args) => {
      if (args.role === undefined) throw badRequest('role is required: a role id, "none", or null to follow the workspace default')
      const ws = await workspaceOf(ctx, args)
      const printerId = printerIdOf(args)
      if (!printerId) {
        const access = await setDefaultRole(ctx, ws, { defaultRole: args.role })
        return output(`Everyone now gets ${access.defaultRole} on printers without their own setting.`, { access })
      }
      const access = await setEveryoneRole(ctx, ws, printerId, { everyoneRole: args.role })
      return output(`Everyone now gets ${access.effectiveEveryoneRole} on this printer.`, { access })
    },
  },
  {
    name: 'grant_printer_access',
    title: 'Grant printer access',
    description:
      'Gives a member, group or device a role on one printer (needs access on it), or on every printer when printerId is omitted (admins; Everyone allowed there). Granting again replaces the role.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ printerId: text('Printer id; omit for every printer'), subject: SUBJECT, role: ROLE }, ['subject', 'role']),
    run: async (ctx, args) => {
      const ws = await workspaceOf(ctx, args)
      const printerId = printerIdOf(args)
      const body = pick(args, ['subject', 'role'])
      const grant = printerId ? await grantPrinterAccess(ctx, ws, printerId, body) : await grantWorkspaceAccess(ctx, ws, body)
      return output(`Granted ${grantLine(grant)} (grant ${grant.id}).`, { grant })
    },
  },
  {
    name: 'revoke_printer_access',
    title: 'Revoke printer access',
    description: 'Removes a grant, from get_printer_access. Admins, or anyone with access on the grant’s printer.',
    scope: 'write',
    annotations: REMOVE,
    inputSchema: inWorkspace({ grantId: text('Grant id, from get_printer_access') }, ['grantId']),
    run: async (ctx, args) => {
      const id = str(args, 'grantId', { max: 64 })
      await revokeGrant(ctx, await workspaceOf(ctx, args), id)
      return output(`Removed grant ${id}.`, { removed: id })
    },
  },
  {
    name: 'explain_printer_access',
    title: 'Explain printer access',
    description: 'Why a member, group, device or Everyone has the permissions they have on a printer: workspace role, Everyone role, and each grant. Admins, or access on the printer.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace({ printerId: PRINTER_ID, subject: SUBJECT }, ['printerId', 'subject']),
    run: async (ctx, args) => {
      const explanation = await explainAccess(ctx, await workspaceOf(ctx, args), printerIdOf(args), args.subject)
      const why = explanation.sources.map((s) => (s.kind === 'grant' ? `grant ${s.grantId}: ${s.role}` : `${s.kind}: ${s.role}`))
      return output(`${explanation.permissions.join(', ') || 'No access'}${why.length ? ` (${why.join('; ')})` : ''}.`, { explanation })
    },
  },
]

/** Listed only while the extension is available on the instance (extensions/tools.ts). */
export const printerAccessTools: Tool[] = [...groupTools, ...accessTools]
