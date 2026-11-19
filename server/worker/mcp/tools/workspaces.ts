import { str } from '../../http/validate'
import { listAudit } from '../../services/audit'
import { getInstanceSettings, patchInstanceSettings } from '../../services/instance'
import { createInvite } from '../../services/invites'
import { getMe } from '../../services/me'
import { listMembers, removeMember, updateMemberRole } from '../../services/members'
import { createWorkspace, listWorkspaces, patchWorkspace } from '../../services/workspaces'
import { ACTION, choice, inWorkspace, integer, object, output, pick, READ, REMOVE, text, UPDATE, workspaceOf, type Tool } from '../tool'
import { INSTANCE_SETTINGS, WORKSPACE_SETTINGS } from './schemas'

const ROLES = ['owner', 'admin', 'member'] as const
const USER_ID = text('User id, from list_members')
const userIdOf = (args: Record<string, unknown>) => str(args, 'userId', { max: 64 })

export const accountTools: Tool[] = [
  {
    name: 'whoami',
    title: 'Who am I',
    description: 'The signed-in user, their workspaces with roles, whether they are an instance admin, and the workspace this connection is limited to (if any).',
    scope: 'read',
    annotations: READ,
    inputSchema: object({}),
    run: async (ctx) => {
      const user = getMe(ctx)
      const workspaces = await listWorkspaces(ctx)
      const limitedTo = ctx.actor.type === 'token' ? ctx.actor.workspaceId : null
      return output(`${user.name} (@${user.username})${user.isAdmin ? ', instance admin' : ''}, in ${workspaces.length} workspace(s).`, { user, workspaces, limitedTo })
    },
  },
]

export const workspaceTools: Tool[] = [
  {
    name: 'list_workspaces',
    title: 'List workspaces',
    description: 'Workspaces you belong to, with your role in each.',
    scope: 'read',
    annotations: READ,
    inputSchema: object({}),
    run: async (ctx) => {
      const workspaces = await listWorkspaces(ctx)
      return output(`${workspaces.length} workspace(s).`, { workspaces })
    },
  },
  {
    name: 'create_workspace',
    title: 'Create workspace',
    description: 'Creates a workspace (a home or an office) with you as its owner.',
    scope: 'write',
    annotations: ACTION,
    inputSchema: object({ name: text('Workspace name, e.g. "Home"') }, ['name']),
    run: async (ctx, args) => {
      const workspace = await createWorkspace(ctx, pick(args, ['name']))
      return output(`Created workspace "${workspace.name}" (${workspace.id}); you are its owner.`, { workspace })
    },
  },
  {
    name: 'update_workspace',
    title: 'Update workspace',
    description: 'Renames a workspace or changes its settings: auto-add, document retention, job timeout, upload limit, LAN sharing default, email-to-print, default printer. Admins and owners only.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ name: text('New name'), settings: WORKSPACE_SETTINGS }),
    run: async (ctx, args) => {
      const workspace = await patchWorkspace(ctx, await workspaceOf(ctx, args), pick(args, ['name', 'settings']))
      return output(`Updated workspace "${workspace.name}".`, { workspace })
    },
  },
  {
    name: 'list_members',
    title: 'List members',
    description: 'People in the workspace and their roles (owner, admin, member).',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const members = await listMembers(ctx, await workspaceOf(ctx, args))
      return output(`${members.length} member(s).`, { members })
    },
  },
  {
    name: 'invite_member',
    title: 'Invite member',
    description: 'Creates an invite link (valid 7 days) and returns it to share; also emails it when an address is given and outbound email is set up. Admins and owners only.',
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace({ role: choice('Role for the new member', ROLES), email: text('Email address to send the invite to (optional)') }, ['role']),
    run: async (ctx, args) => {
      const { invite, url } = await createInvite(ctx, await workspaceOf(ctx, args), pick(args, ['role', 'email']))
      return output(`Invite link (${invite.role}): ${url}`, { invite, url })
    },
  },
  {
    name: 'update_member_role',
    title: 'Change member role',
    description: 'Changes a member’s role. Only owners grant or revoke owner; the last owner cannot be demoted.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ userId: USER_ID, role: choice('New role', ROLES) }, ['userId', 'role']),
    run: async (ctx, args) => {
      const member = await updateMemberRole(ctx, await workspaceOf(ctx, args), userIdOf(args), pick(args, ['role']))
      return output(`${member.name} is now ${member.role}.`, { member })
    },
  },
  {
    name: 'remove_member',
    title: 'Remove member',
    description: 'Removes someone from the workspace (or yourself, to leave). The last owner cannot leave.',
    scope: 'write',
    annotations: REMOVE,
    inputSchema: inWorkspace({ userId: USER_ID }, ['userId']),
    run: async (ctx, args) => {
      const userId = userIdOf(args)
      await removeMember(ctx, await workspaceOf(ctx, args), userId)
      return output(`Removed member ${userId}.`, { removed: userId })
    },
  },
  {
    name: 'list_audit',
    title: 'Recent activity',
    description: 'Audit log for the workspace, newest first. Admins and owners only.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace({ cursor: text('nextCursor from the previous page'), limit: integer('Entries per page', 1, 200) }),
    run: async (ctx, args) => {
      const limit = args.limit === undefined ? null : String(args.limit)
      const page = await listAudit(ctx, await workspaceOf(ctx, args), typeof args.cursor === 'string' ? args.cursor : null, limit)
      return output(`${page.items.length} entr${page.items.length === 1 ? 'y' : 'ies'}${page.nextCursor ? '; more available' : ''}.`, { items: page.items, nextCursor: page.nextCursor })
    },
  },
]

export const instanceTools: Tool[] = [
  {
    name: 'get_instance_settings',
    title: 'Instance settings',
    description: 'Server-wide settings: app name, signup policy, single sign-on, email. Instance admins only; secrets are reported as present or absent, never returned.',
    scope: 'read',
    annotations: READ,
    inputSchema: object({}),
    run: async (ctx) => {
      const settings = await getInstanceSettings(ctx)
      return output(`Signup is ${settings.signup}; outbound email: ${settings.email.provider}.`, { settings })
    },
  },
  {
    name: 'update_instance_settings',
    title: 'Update instance settings',
    description: 'Changes server-wide settings (deep-merged). Instance admins only. Secret fields are write-only: a string sets them, null clears them.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: object(INSTANCE_SETTINGS),
    run: async (ctx, args) => {
      const settings = await patchInstanceSettings(ctx, pick(args, Object.keys(INSTANCE_SETTINGS)))
      return output('Updated the instance settings.', { settings })
    },
  },
]
