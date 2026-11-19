import type { Group } from '../../../shared/access'
import { badRequest } from '../../http/errors'
import { str } from '../../http/validate'
import { ACTION, bool, choice, inWorkspace, nullableText, output, pick, READ, REMOVE, text, UPDATE, workspaceOf, type Tool } from '../../mcp/tool'
import { createGroup, deleteGroup, listGroups, setGroupMember, updateGroup } from './groups'

const GROUP_ID = text('Group id, from list_groups')
const groupIdOf = (args: Record<string, unknown>) => str(args, 'groupId', { max: 64 })
const describe = (g: Group) => `${g.name}: ${g.members.length ? g.members.map((m) => m.name).join(', ') : 'no members'}`

export const groupTools: Tool[] = [
  {
    name: 'list_groups',
    title: 'List groups',
    description: 'Groups of members and devices that printer access can be granted to, with their members. Needs the printer access extension.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const groups = await listGroups(ctx, await workspaceOf(ctx, args))
      return output(groups.length ? groups.map(describe).join('\n') : 'No groups yet.', { groups })
    },
  },
  {
    name: 'create_group',
    title: 'Create group',
    description: 'Creates an empty group of members and devices, for example "Front office". Admins and owners only.',
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace({ name: text('Group name, unique in the workspace'), description: nullableText('What the group is for') }, ['name']),
    run: async (ctx, args) => {
      const group = await createGroup(ctx, await workspaceOf(ctx, args), pick(args, ['name', 'description']))
      return output(`Created group ${group.name} (${group.id}). Add people and devices with set_group_member.`, { group })
    },
  },
  {
    name: 'update_group',
    title: 'Update group',
    description: 'Renames a group or changes its description. Admins and owners only.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ groupId: GROUP_ID, name: text('New name'), description: nullableText('New description; null clears it') }, ['groupId']),
    run: async (ctx, args) => {
      const group = await updateGroup(ctx, await workspaceOf(ctx, args), groupIdOf(args), pick(args, ['name', 'description']))
      return output(`Updated ${describe(group)}.`, { group })
    },
  },
  {
    name: 'delete_group',
    title: 'Delete group',
    description: 'Deletes a group and every grant given to it. Its members keep their other access. Admins and owners only.',
    scope: 'write',
    annotations: REMOVE,
    inputSchema: inWorkspace({ groupId: GROUP_ID }, ['groupId']),
    run: async (ctx, args) => {
      const id = groupIdOf(args)
      await deleteGroup(ctx, await workspaceOf(ctx, args), id)
      return output(`Deleted group ${id} and its grants.`, { removed: id })
    },
  },
  {
    name: 'set_group_member',
    title: 'Add or remove group member',
    description:
      'Adds a person (memberType user, a user id from list_members) or a device (memberType client, a device id from list_devices) to a group, or removes it with inGroup false. Admins and owners only.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace(
      {
        groupId: GROUP_ID,
        memberType: choice('user for a person, client for a device', ['user', 'client']),
        memberId: text('User id or device id'),
        inGroup: bool('true adds, false removes'),
      },
      ['groupId', 'memberType', 'memberId', 'inGroup'],
    ),
    run: async (ctx, args) => {
      if (typeof args.inGroup !== 'boolean') throw badRequest('inGroup must be true or false')
      const type = str(args, 'memberType', { max: 10 })
      const group = await setGroupMember(ctx, await workspaceOf(ctx, args), groupIdOf(args), type, str(args, 'memberId', { max: 64 }), args.inGroup)
      return output(`${describe(group)}.`, { group })
    },
  },
]
