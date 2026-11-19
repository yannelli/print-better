import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { grant, myAccess, newGroup, ok, setEveryone, turnOnAccess, wsPath } from './helpers/access'
import { connectPrinter } from './helpers/device'
import type { Reply } from './helpers/http'
import { freshWorkspace } from './helpers/jobs'
import { addMember, enrollDevice, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let ws: string
let bob: Person

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  await turnOnAccess(owner)
  bob = await addMember(owner)
})

const p = (path: string) => wsPath(ws, path)
const code = (r: Reply) => [r.status, r.body?.error?.code ?? null]
const BOB = () => ({ type: 'user' as const, id: bob.user.id })

let keys = 0
async function printer(workspaceId = ws): Promise<string> {
  const s = await connectPrinter(owner, `usb:m${++keys}`, workspaceId)
  s.device.close()
  return s.printerId
}

const newRole = async (name: string, permissions: string[]) => ok(await owner.agent.post(p('/access/roles'), { name, permissions }), 'role')

describe('groups', () => {
  it('are created, renamed and deleted by admins, with names unique in any case', async () => {
    expect(code(await bob.agent.post(p('/groups'), { name: 'Mine' }))).toEqual([403, 'forbidden'])
    const made = await owner.agent.post(p('/groups'), { name: 'Front office' })
    expect(made).toMatchObject({ status: 200, body: { name: 'Front office', description: null, members: [] } })
    expect(code(await owner.agent.post(p('/groups'), { name: 'front OFFICE' }))).toEqual([409, 'name_taken'])
    expect(code(await owner.agent.post(p('/groups'), { name: '' }))).toEqual([400, 'invalid_request'])
    const renamed = ok(await owner.agent.patch(p(`/groups/${made.body.id}`), { name: 'Reception', description: 'By the door' }), 'rename')
    expect(renamed).toMatchObject({ name: 'Reception', description: 'By the door' })
    expect(ok(await bob.agent.get(p('/groups')), 'list').map((g: { name: string }) => g.name)).toContain('Reception')
    expect((await owner.agent.del(p(`/groups/${made.body.id}`))).status).toBe(204)
    expect(code(await owner.agent.patch(p(`/groups/${made.body.id}`), { name: 'Back' }))).toEqual([404, 'not_found'])
  })

  it('hold members and devices of this workspace only, and deleting one drops its grants', async () => {
    const groupId = await newGroup(owner.agent, ws, 'Desks')
    const desk = await enrollDevice(owner)
    const member = (type: string, id: string) => p(`/groups/${groupId}/members/${type}/${id}`)
    ok(await owner.agent.put(member('user', bob.user.id), {}), 'add bob')
    const both = ok(await owner.agent.put(member('client', desk.clientId), {}), 'add desk')
    expect(both.members).toEqual([
      { type: 'user', id: bob.user.id, name: bob.user.name },
      { type: 'client', id: desk.clientId, name: 'office-pi' },
    ])
    expect(ok(await owner.agent.put(member('user', bob.user.id), {}), 'again').members).toHaveLength(2)

    const elsewhere = await enrollDevice(owner, await freshWorkspace(owner))
    expect((await owner.agent.put(member('client', elsewhere.clientId), {})).body.error.message).toBe('Device not found')
    expect((await owner.agent.put(member('user', 'nobody'), {})).body.error.message).toBe('Member not found')
    expect(code(await owner.agent.put(member('robot', 'r2'), {}))).toEqual([400, 'invalid_request'])
    expect(ok(await owner.agent.del(member('user', bob.user.id)), 'remove').members).toHaveLength(1)

    const id = await printer()
    const given = await grant(owner.agent, ws, id, { type: 'group', id: groupId }, 'user')
    await owner.agent.del(p(`/groups/${groupId}`))
    expect(code(await owner.agent.del(p(`/access/grants/${given.id}`)))).toEqual([404, 'not_found'])
  })
})

describe('roles', () => {
  it('need permissions and a name no built-in role or other role has, and store implied permissions', async () => {
    expect(code(await owner.agent.post(p('/access/roles'), { name: 'Empty', permissions: [] }))).toEqual([400, 'invalid_request'])
    expect((await owner.agent.post(p('/access/roles'), { name: 'Pilot', permissions: ['fly'] })).body.error.message).toContain('Unknown permission fly')
    expect(code(await owner.agent.post(p('/access/roles'), { name: 'viewer', permissions: ['print'] }))).toEqual([409, 'name_taken'])
    expect(code(await owner.agent.post(p('/access/roles'), { name: 'None', permissions: ['print'] }))).toEqual([409, 'name_taken'])
    const desk = await newRole('Jobs desk', ['jobs.manage'])
    expect(desk).toMatchObject({ name: 'Jobs desk', builtIn: false, permissions: ['view', 'jobs.read', 'jobs.manage'] })
    expect(code(await owner.agent.post(p('/access/roles'), { name: 'JOBS DESK', permissions: ['print'] }))).toEqual([409, 'name_taken'])
    expect(code(await bob.agent.post(p('/access/roles'), { name: 'Bob’s', permissions: ['print'] }))).toEqual([403, 'forbidden'])
    const roles = ok(await owner.agent.get(p('/access')), 'access').roles.map((r: { id: string }) => r.id)
    expect(roles.slice(0, 3)).toEqual(['viewer', 'user', 'manager'])
    expect(roles).toContain(desk.id)
  })

  it('change everyone holding them at once', async () => {
    const id = await printer()
    const role = await newRole('Prints only', ['print'])
    await setEveryone(owner.agent, ws, id, 'none')
    await grant(owner.agent, ws, id, BOB(), role.id)
    expect((await myAccess(bob.agent, ws)).printers[id]).toEqual(['view', 'print'])
    ok(await owner.agent.patch(p(`/access/roles/${role.id}`), { permissions: ['print', 'jobs.read'] }), 'widen')
    expect((await myAccess(bob.agent, ws)).printers[id]).toEqual(['view', 'print', 'jobs.read'])
  })

  it('cannot be deleted while a grant, a printer or the workspace default uses them', async () => {
    const id = await printer()
    const role = await newRole('Front desk', ['print'])
    const given = await grant(owner.agent, ws, id, BOB(), role.id)
    await setEveryone(owner.agent, ws, id, role.id)
    ok(await owner.agent.patch(p('/access'), { defaultRole: role.id }), 'default')
    const refused = await owner.agent.del(p(`/access/roles/${role.id}`))
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'role_in_use' } } })
    expect(refused.body.error.message).toBe('"Front desk" is still used by 1 grant, the Everyone setting of 1 printer and the workspace default role. Change those first.')

    ok(await owner.agent.patch(p('/access'), { defaultRole: 'user' }), 'default back')
    await setEveryone(owner.agent, ws, id, null)
    expect((await owner.agent.del(p(`/access/roles/${role.id}`))).body.error.message).toBe('"Front desk" is still used by 1 grant. Change those first.')
    await owner.agent.del(p(`/access/grants/${given.id}`))
    expect((await owner.agent.del(p(`/access/roles/${role.id}`))).status).toBe(204)
    expect(code(await owner.agent.patch(p(`/access/roles/${role.id}`), { name: 'Gone' }))).toEqual([404, 'not_found'])
  })
})

describe('grants', () => {
  it('hold one role per subject and printer: granting again replaces it', async () => {
    const id = await printer()
    const first = await grant(owner.agent, ws, id, BOB(), 'viewer')
    const again = await grant(owner.agent, ws, id, BOB(), 'manager')
    expect(again).toMatchObject({ id: first.id, role: 'manager', printerId: id, subject: BOB(), subjectName: bob.user.name })
    expect(ok(await owner.agent.get(p(`/printers/${id}/access`)), 'access').grants).toHaveLength(1)
    const wide = await grant(owner.agent, ws, null, BOB(), 'viewer')
    expect(wide.id).not.toBe(first.id)
    await owner.agent.del(p(`/access/grants/${wide.id}`))
  })

  it('refuse Everyone on one printer, no-access roles, unknown roles and outsiders', async () => {
    const id = await printer()
    const post = (body: unknown) => owner.agent.post(p(`/printers/${id}/access/grants`), body)
    expect((await post({ subject: { type: 'everyone' }, role: 'user' })).body.error.message).toBe("Set the printer's Everyone role instead of granting Everyone access to one printer")
    expect((await post({ subject: BOB(), role: 'none' })).body.error.message).toBe('role can\'t be "none": grants only add access')
    expect(code(await post({ subject: BOB(), role: 'boss' }))).toEqual([400, 'invalid_request'])
    expect(code(await post({ subject: { type: 'user', id: 'nobody' }, role: 'user' }))).toEqual([404, 'not_found'])
    expect(code(await post({ subject: { type: 'robot' }, role: 'user' }))).toEqual([400, 'invalid_request'])
  })

  it('are removed by admins, or by people with access on that printer', async () => {
    const id = await printer()
    const carol = await addMember(owner)
    const hers = await grant(owner.agent, ws, id, { type: 'user', id: carol.user.id }, 'user')
    const wide = await grant(owner.agent, ws, null, { type: 'user', id: carol.user.id }, 'viewer')
    expect(code(await bob.agent.del(p(`/access/grants/${hers.id}`)))).toEqual([403, 'printer_access_denied'])
    await grant(owner.agent, ws, id, BOB(), 'manager')
    expect((await bob.agent.del(p(`/access/grants/${hers.id}`))).status).toBe(204)
    expect(code(await bob.agent.del(p(`/access/grants/${wide.id}`)))).toEqual([403, 'forbidden'])
    expect(code(await bob.agent.del(p('/access/grants/nope')))).toEqual([404, 'not_found'])
  })
})

describe('explaining access', () => {
  it('names every source for a member, a group, a device and Everyone', async () => {
    const id = await printer()
    const desk = await enrollDevice(owner)
    const groupId = await newGroup(owner.agent, ws, 'Explained', [{ type: 'user', id: bob.user.id }])
    await setEveryone(owner.agent, ws, id, 'viewer')
    const viaGroup = await grant(owner.agent, ws, id, { type: 'group', id: groupId }, 'user')
    const forDesk = await grant(owner.agent, ws, null, { type: 'client', id: desk.clientId }, 'manager')
    const explain = async (subject: string) => ok(await owner.agent.get(p(`/access/explain?printer=${id}&subject=${subject}`)), subject)
    const everyone = { kind: 'everyone', role: 'viewer' }
    const group = { kind: 'grant', role: 'user', grantId: viaGroup.id, via: { type: 'group', id: groupId } }

    expect(await explain(`user:${bob.user.id}`)).toEqual({ permissions: ['view', 'print', 'jobs.read'], sources: [everyone, group] })
    expect(await explain(`group:${groupId}`)).toEqual({ permissions: ['view', 'print', 'jobs.read'], sources: [everyone, group] })
    expect((await explain(`client:${desk.clientId}`)).sources).toEqual([everyone, { kind: 'grant', role: 'manager', grantId: forDesk.id, via: { type: 'client', id: desk.clientId } }])
    expect(await explain('everyone')).toEqual({ permissions: ['view'], sources: [everyone] })
    expect(await explain(`user:${owner.user.id}`)).toEqual({ permissions: ['view', 'print', 'jobs.read', 'jobs.manage', 'settings', 'access'], sources: [{ kind: 'workspace-role', role: 'owner' }] })
    expect(code(await bob.agent.get(p(`/access/explain?printer=${id}&subject=everyone`)))).toEqual([403, 'printer_access_denied'])
    expect(code(await owner.agent.get(p(`/access/explain?subject=everyone`)))).toEqual([400, 'invalid_request'])
    await owner.agent.del(p(`/access/grants/${forDesk.id}`))
  })

  it('reports what a subject may do on every printer, for admins', async () => {
    const open = await printer()
    const locked = await printer()
    const desk = await enrollDevice(owner)
    await setEveryone(owner.agent, ws, locked, 'none')
    await grant(owner.agent, ws, locked, { type: 'client', id: desk.clientId }, 'viewer')
    const of = async (subject: string) => ok(await owner.agent.get(p(`/access/subject?subject=${subject}`)), subject).printers
    const bobs = await of(`user:${bob.user.id}`)
    expect(bobs[open]).toEqual(['view', 'print', 'jobs.read'])
    expect(bobs[locked]).toBeUndefined()
    expect((await of(`client:${desk.clientId}`))[locked]).toEqual(['view'])
    expect((await of('everyone'))[locked]).toBeUndefined()
    expect((await of(`user:${owner.user.id}`))[locked]).toHaveLength(6)
    expect(code(await bob.agent.get(p(`/access/subject?subject=everyone`)))).toEqual([403, 'forbidden'])
  })
})

const rows = async (table: string, userId: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(userId).first<{ n: number }>())?.n

describe('people leaving', () => {
  it('takes their grants and group memberships with them, removed or deleted', async () => {
    const id = await printer()
    for (const how of ['remove', 'delete'] as const) {
      const carol = await addMember(owner)
      await newGroup(owner.agent, ws, `Group for ${how}`, [{ type: 'user', id: carol.user.id }])
      await grant(owner.agent, ws, id, { type: 'user', id: carol.user.id }, 'user')
      await grant(owner.agent, ws, null, { type: 'user', id: carol.user.id }, 'viewer')
      expect([await rows('printer_grants', carol.user.id), await rows('group_members', carol.user.id)]).toEqual([2, 1])
      const path = how === 'remove' ? p(`/members/${carol.user.id}`) : `/api/admin/users/${carol.user.id}`
      expect((await owner.agent.del(path)).status).toBe(204)
      expect([await rows('printer_grants', carol.user.id), await rows('group_members', carol.user.id)]).toEqual([0, 0])
    }
  })
})

describe('audit', () => {
  it('records every change to groups, roles, grants and Everyone, and nothing for no-ops', async () => {
    const other = await freshWorkspace(owner)
    await turnOnAccess(owner, other)
    const q = (path: string) => wsPath(other, path)
    const id = await printer(other)
    const groupId = await newGroup(owner.agent, other, 'Audited')
    await owner.agent.put(q(`/groups/${groupId}/members/user/${owner.user.id}`), {})
    await owner.agent.put(q(`/groups/${groupId}/members/user/${owner.user.id}`), {})
    await owner.agent.del(q(`/groups/${groupId}/members/user/${owner.user.id}`))
    await owner.agent.patch(q(`/groups/${groupId}`), { name: 'Audited too' })
    const role = ok(await owner.agent.post(q('/access/roles'), { name: 'Audit role', permissions: ['print'] }), 'role')
    await owner.agent.patch(q(`/access/roles/${role.id}`), { permissions: ['print', 'jobs.read'] })
    const given = await grant(owner.agent, other, id, { type: 'group', id: groupId }, role.id)
    await grant(owner.agent, other, id, { type: 'group', id: groupId }, role.id)
    await owner.agent.del(q(`/access/grants/${given.id}`))
    await owner.agent.del(q(`/access/roles/${role.id}`))
    await setEveryone(owner.agent, other, id, 'none')
    await setEveryone(owner.agent, other, id, 'none')
    await owner.agent.patch(q('/access'), { defaultRole: 'viewer' })
    await owner.agent.del(q(`/groups/${groupId}`))

    const sql = "SELECT action, target, data FROM audit_log WHERE workspace_id = ? AND (action LIKE 'access.%' OR action LIKE 'group.%') ORDER BY id"
    const log = (await env.DB.prepare(sql).bind(other).all()).results
    expect(log.map((e) => e.action)).toEqual([
      'group.create', 'group.add', 'group.remove', 'group.update', 'access.role_create', 'access.role_update',
      'access.grant', 'access.revoke', 'access.role_delete', 'access.update', 'access.update', 'group.delete',
    ])
    expect(log.map((e) => e.target)).toEqual([groupId, groupId, groupId, groupId, role.id, role.id, given.id, given.id, role.id, id, other, groupId])
    expect(JSON.parse(String(log[6].data))).toEqual({ printerId: id, subject: { type: 'group', id: groupId }, role: role.id })
    expect(JSON.parse(String(log[9].data))).toEqual({ everyoneRole: 'none' })
    expect(JSON.parse(String(log[10].data))).toEqual({ defaultRole: 'viewer' })
  })
})
