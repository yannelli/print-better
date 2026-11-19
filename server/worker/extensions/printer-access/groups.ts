import type { Group, GroupMember } from '../../../shared/access'
import type { Json } from '../../http/body'
import { badRequest, conflict, notFound } from '../../http/errors'
import { nullableStr, optStr, str } from '../../http/validate'
import { newId } from '../../lib/crypto'
import { all, run } from '../../lib/db'
import type { Ctx } from '../../services/context'
import { changed, enter } from './guard'
import { principalOf } from './values'

const GROUP_NAME = { max: 60 }
const DESCRIPTION = { max: 200 }

interface GroupRow {
  id: string
  name: string
  description: string | null
  created_at: number
  updated_at: number
}

type MemberRow = { group_id: string; type: GroupMember['type']; id: string; name: string }

async function groupViews(env: Env, workspaceId: string, groupId: string | null = null): Promise<Group[]> {
  const [groups, members] = await Promise.all([
    all<GroupRow>(env.DB, 'SELECT * FROM groups WHERE workspace_id = ? AND (? IS NULL OR id = ?) ORDER BY name COLLATE NOCASE', workspaceId, groupId, groupId),
    all<MemberRow>(
      env.DB,
      `SELECT gm.group_id, gm.member_type AS type, COALESCE(gm.user_id, gm.client_id) AS id, COALESCE(u.name, c.name) AS name
       FROM group_members gm LEFT JOIN users u ON u.id = gm.user_id LEFT JOIN clients c ON c.id = gm.client_id
       WHERE gm.workspace_id = ? AND (? IS NULL OR gm.group_id = ?) ORDER BY gm.member_type DESC, name COLLATE NOCASE`,
      workspaceId,
      groupId,
      groupId,
    ),
  ])
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    members: members.filter((m) => m.group_id === g.id).map(({ type, id, name }) => ({ type, id, name })),
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  }))
}

async function groupView(env: Env, workspaceId: string, id: string): Promise<Group> {
  const [group] = await groupViews(env, workspaceId, id)
  if (!group) throw notFound('Group not found')
  return group
}

/** Writes that hit the unique name index become a plain 409. */
async function named(write: () => Promise<unknown>): Promise<void> {
  try {
    await write()
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('Another group already has that name', 'name_taken')
    throw e
  }
}

export async function listGroups(ctx: Ctx, workspaceId: string): Promise<Group[]> {
  await enter(ctx, workspaceId, 'read')
  return groupViews(ctx.env, workspaceId)
}

export async function createGroup(ctx: Ctx, workspaceId: string, body: Json): Promise<Group> {
  await enter(ctx, workspaceId, 'write', true)
  const id = newId()
  const name = str(body, 'name', GROUP_NAME)
  const now = Date.now()
  await named(() =>
    run(
      ctx.env.DB,
      'INSERT INTO groups (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      workspaceId,
      name,
      nullableStr(body, 'description', DESCRIPTION) ?? null,
      now,
      now,
    ),
  )
  await changed(ctx, workspaceId, 'group.create', id, { name })
  return groupView(ctx.env, workspaceId, id)
}

export async function updateGroup(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<Group> {
  await enter(ctx, workspaceId, 'write', true)
  const group = await groupView(ctx.env, workspaceId, id)
  const name = optStr(body, 'name', GROUP_NAME) ?? group.name
  const description = nullableStr(body, 'description', DESCRIPTION)
  await named(() =>
    run(ctx.env.DB, 'UPDATE groups SET name = ?, description = ?, updated_at = ? WHERE id = ?', name, description === undefined ? group.description : description, Date.now(), id),
  )
  await changed(ctx, workspaceId, 'group.update', id, { fields: Object.keys(body) })
  return groupView(ctx.env, workspaceId, id)
}

/** Its grants go with it. */
export async function deleteGroup(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  await enter(ctx, workspaceId, 'write', true)
  const group = await groupView(ctx.env, workspaceId, id)
  await run(ctx.env.DB, 'DELETE FROM groups WHERE id = ?', id)
  await changed(ctx, workspaceId, 'group.delete', id, { name: group.name })
}

/** Adds (`member: true`) or removes a member (`user`) or device (`client`); repeating either is a no-op. */
export async function setGroupMember(ctx: Ctx, workspaceId: string, id: string, type: string, memberId: string, member: boolean): Promise<Group> {
  await enter(ctx, workspaceId, 'write', true)
  if (type !== 'user' && type !== 'client') throw badRequest('Group members are people (user) or devices (client)')
  await groupView(ctx.env, workspaceId, id)
  await principalOf(ctx.env, workspaceId, { type, id: memberId })
  const column = type === 'user' ? 'user_id' : 'client_id'
  const done = member
    ? await run(
        ctx.env.DB,
        `INSERT INTO group_members (group_id, workspace_id, member_type, ${column}, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        id,
        workspaceId,
        type,
        memberId,
        Date.now(),
      )
    : await run(ctx.env.DB, `DELETE FROM group_members WHERE group_id = ? AND member_type = ? AND ${column} = ?`, id, type, memberId)
  if (done > 0) {
    await run(ctx.env.DB, 'UPDATE groups SET updated_at = ? WHERE id = ?', Date.now(), id)
    await changed(ctx, workspaceId, member ? 'group.add' : 'group.remove', id, { type, id: memberId })
  }
  return groupView(ctx.env, workspaceId, id)
}
