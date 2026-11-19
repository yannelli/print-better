import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ok } from './helpers/access'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'
import { auditOf, office, type Office, rulesPath, turnOnPolicies } from './helpers/usage'

let owner: Owner
let member: Person
let ws: string
let printers: Office

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  member = await addMember(owner)
  printers = await office(owner, ws)
})
afterAll(() => printers.device.close())

const create = async (body: unknown) => ok(await owner.agent.post(rulesPath(ws), body), 'create rule')
const NOTE = [{ type: 'note', message: 'Checked' }]

describe('rules while the extension is off', () => {
  it('answer 404 extension_inactive', async () => {
    const reply = await owner.agent.get(rulesPath(ws))
    expect(reply.status).toBe(404)
    expect(reply.body.error).toMatchObject({ code: 'extension_inactive', message: expect.stringContaining('Print rules and limits is turned off') })
  })
})

describe('managing rules', () => {
  beforeAll(() => turnOnPolicies(owner, ws))

  it('are for owners and admins only', async () => {
    expect((await member.agent.get(rulesPath(ws))).status).toBe(403)
    expect((await member.agent.post(rulesPath(ws), { name: 'Mine', actions: NOTE })).status).toBe(403)
    const admin = await addMember(owner, 'admin')
    expect(ok(await admin.agent.get(rulesPath(ws)), 'list')).toEqual(expect.any(Array))
  })

  it('add rules at the bottom, edit them, reorder them, and delete them, auditing each change', async () => {
    const first = await create({ name: 'Big jobs on both sides', conditions: { pages: { min: 10 } }, actions: [{ type: 'two-sided' }] })
    expect(first).toMatchObject({ name: 'Big jobs on both sides', enabled: true, exemptAdmins: false, conditions: { pages: { min: 10 } }, actions: [{ type: 'two-sided' }] })
    const second = await create({ name: 'Weekend note', enabled: false, exemptAdmins: true, conditions: { time: { days: [6, 0], from: '00:00', to: '00:00' } }, actions: NOTE })
    expect(ok(await owner.agent.get(rulesPath(ws)), 'list').map((r: { id: string }) => r.id)).toEqual([first.id, second.id])

    const edited = ok(await owner.agent.patch(rulesPath(ws, `/${second.id}`), { name: 'Weekends', enabled: true }), 'edit')
    expect(edited).toMatchObject({ name: 'Weekends', enabled: true, exemptAdmins: true, actions: NOTE, conditions: second.conditions })

    const order = ok(await owner.agent.put(rulesPath(ws, '/order'), { ids: [second.id, first.id] }), 'reorder')
    expect(order.map((r: { id: string }) => r.id)).toEqual([second.id, first.id])

    expect((await owner.agent.del(rulesPath(ws, `/${first.id}`))).status).toBe(204)
    expect((await owner.agent.del(rulesPath(ws, `/${first.id}`))).status).toBe(404)
    expect((await auditOf(ws, 'rule.')).map((a) => a.action)).toEqual(['rule.create', 'rule.create', 'rule.update', 'rule.reorder', 'rule.delete'])
    expect((await owner.agent.del(rulesPath(ws, `/${second.id}`))).status).toBe(204)
  })

  it('refuse unknown keys, bad values, and members, groups, devices or printers that don’t exist', async () => {
    const bad: unknown[] = [
      { name: 'No actions', actions: [] },
      { name: 'Typo', actions: NOTE, condition: {} },
      { name: 'Unknown condition', conditions: { colour: true }, actions: NOTE },
      { name: 'Backwards pages', conditions: { pages: { min: 10, max: 5 } }, actions: NOTE },
      { name: 'Empty pages', conditions: { pages: {} }, actions: NOTE },
      { name: 'Bad time', conditions: { time: { days: [1], from: '25:00', to: '06:00' } }, actions: NOTE },
      { name: 'Bad day', conditions: { time: { days: [7], from: '08:00', to: '09:00' } }, actions: NOTE },
      { name: 'Bad source', conditions: { sources: ['lan'] }, actions: NOTE },
      { name: 'Bad kind', conditions: { fileKinds: ['word'] }, actions: NOTE },
      { name: 'Bad size', conditions: { minSizeMb: 0 }, actions: NOTE },
      { name: 'Unknown action', actions: [{ type: 'shred' }] },
      { name: 'Extra key', actions: [{ type: 'two-sided', edge: 'short' }] },
      { name: 'Empty message', actions: [{ type: 'block', message: ' ' }] },
      { name: 'No copies', actions: [{ type: 'max-copies', copies: 0 }] },
      { name: 'Missing member', conditions: { who: [{ type: 'user', id: 'nobody' }] }, actions: NOTE },
      { name: 'Missing group', conditions: { who: [{ type: 'group', id: 'nobody' }] }, actions: NOTE },
      { name: 'Missing device', conditions: { who: [{ type: 'client', id: 'nobody' }] }, actions: NOTE },
      { name: 'Missing printer', conditions: { printers: ['nobody'] }, actions: NOTE },
      { name: 'Missing target', actions: [{ type: 'redirect', printerId: 'nobody' }] },
      { actions: NOTE },
    ]
    for (const body of bad) expect((await owner.agent.post(rulesPath(ws), body)).status, JSON.stringify(body)).toBe(400)
    expect(ok(await owner.agent.get(rulesPath(ws)), 'list')).toEqual([])
  })

  it('accept every condition and action that are well formed', async () => {
    const rule = await create({
      name: 'Everything',
      conditions: {
        who: [{ type: 'user', id: member.user.id }, { type: 'client', id: printers.clientId }],
        sources: ['web', 'api', 'mcp', 'email', 'device', 'test'],
        printers: [printers.color],
        pages: { min: 1, max: 500 },
        minCopies: 2,
        color: true,
        sides: 'one-sided',
        fileKinds: ['pdf', 'image', 'text'],
        minSizeMb: 0.5,
        time: { days: [1, 2, 3, 4, 5], from: '18:00', to: '08:00' },
      },
      actions: [
        { type: 'two-sided' },
        { type: 'monochrome' },
        { type: 'max-copies', copies: 2 },
        { type: 'redirect', printerId: printers.mono },
        { type: 'approval' },
        { type: 'release' },
        { type: 'note', message: 'Printed at night' },
        { type: 'block', message: 'Not tonight' },
      ],
    })
    expect(rule.actions).toHaveLength(8)
    expect(rule.conditions.time).toEqual({ days: [1, 2, 3, 4, 5], from: '18:00', to: '08:00' })
    expect((await owner.agent.del(rulesPath(ws, `/${rule.id}`))).status).toBe(204)
  })

  it('reorder only with every rule listed once, and 404 for another workspace’s rule', async () => {
    const a = await create({ name: 'A', actions: NOTE })
    const b = await create({ name: 'B', actions: NOTE })
    for (const ids of [[a.id], [a.id, a.id], [a.id, b.id, 'nobody'], 'all']) {
      expect((await owner.agent.put(rulesPath(ws, '/order'), { ids })).status, JSON.stringify(ids)).toBe(400)
    }
    const other = (await owner.agent.post('/api/workspaces', { name: 'Elsewhere' })).body.id
    await turnOnPolicies(owner, other)
    expect((await owner.agent.patch(rulesPath(other, `/${a.id}`), { name: 'Stolen' })).status).toBe(404)
    expect((await owner.agent.del(rulesPath(other, `/${a.id}`))).status).toBe(404)
    for (const id of [a.id, b.id]) await owner.agent.del(rulesPath(ws, `/${id}`))
  })
})
