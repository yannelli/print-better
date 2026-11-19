import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newGroup, ok, wsPath } from './helpers/access'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'
import { auditOf, limitsPath, office, type Office, switchExtension, turnOnPolicies } from './helpers/usage'

let owner: Owner
let member: Person
let ws: string
let p: Office
let group: string

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  member = await addMember(owner)
  p = await office(owner, ws)
  await switchExtension(owner, 'printer-access', ws, true)
  group = await newGroup(owner.agent, ws, 'Lab', [{ type: 'user', id: member.user.id }])
  await switchExtension(owner, 'printer-access', ws, false)
})
afterAll(() => p.device.close())

const MONTH = { kind: 'month', startDay: 1 }
const create = async (body: object) => ok(await owner.agent.post(limitsPath(ws), { name: 'Monthly pages', unit: 'pages', amount: 50, cycle: MONTH, scope: { type: 'each-member' }, ...body }), 'create limit')

describe('limits while the extension is off', () => {
  it('answer 404 extension_inactive, /usage and /usage/me too', async () => {
    for (const path of [limitsPath(ws), wsPath(ws, '/usage'), wsPath(ws, '/usage/me')]) {
      const reply = await owner.agent.get(path)
      expect([path, reply.status, reply.body.error.code]).toEqual([path, 404, 'extension_inactive'])
    }
  })
})

describe('managing limits', () => {
  beforeAll(() => turnOnPolicies(owner, ws))

  it('are for owners and admins; members only read their own usage', async () => {
    expect((await member.agent.get(limitsPath(ws))).status).toBe(403)
    expect((await member.agent.post(limitsPath(ws), { name: 'Mine', unit: 'jobs', amount: 1, cycle: MONTH, scope: { type: 'workspace' } })).status).toBe(403)
    expect((await member.agent.get(wsPath(ws, '/usage'))).status).toBe(403)
    expect(ok(await member.agent.get(wsPath(ws, '/usage/me')), 'mine')).toEqual({ limits: [] })
  })

  it('take every scope, unit, cycle and action', async () => {
    const scopes = [
      { type: 'each-member' },
      { type: 'member', id: member.user.id },
      { type: 'group', id: group },
      { type: 'group-each', id: group },
      { type: 'each-device' },
      { type: 'device', id: p.clientId },
      { type: 'printer', id: p.color },
      { type: 'workspace' },
    ]
    const cycles = [{ kind: 'day' }, { kind: 'week', firstDay: 1 }, MONTH, { kind: 'quarter', startMonth: 2 }, { kind: 'year', startMonth: 7 }]
    const units = ['pages', 'sheets', 'jobs', 'cost']
    const actions = ['block', 'warn', 'approval']
    const made = []
    for (const [i, scope] of scopes.entries()) {
      const body = { name: `Limit ${i}`, scope, unit: units[i % 4], amount: 10 + i, cycle: cycles[i % 5], action: actions[i % 3], exemptAdmins: i % 2 === 0 }
      const limit = await create(body)
      expect(limit).toMatchObject({ ...body, enabled: true, id: expect.any(String) })
      made.push(limit.id)
    }
    const listed = ok(await owner.agent.get(limitsPath(ws)), 'list')
    expect(listed.map((l: { id: string }) => l.id)).toEqual(made)
    for (const id of made) expect((await owner.agent.del(limitsPath(ws, `/${id}`))).status).toBe(204)
  })

  it('default to blocking, change only what is sent, and audit each change', async () => {
    const limit = await create({ name: 'Pages' })
    expect(limit).toMatchObject({ action: 'block', enabled: true, exemptAdmins: false })
    const edited = ok(await owner.agent.patch(limitsPath(ws, `/${limit.id}`), { amount: 80, enabled: false }), 'edit')
    expect(edited).toMatchObject({ name: 'Pages', amount: 80, enabled: false, scope: { type: 'each-member' }, cycle: MONTH, unit: 'pages' })
    expect((await owner.agent.patch(limitsPath(ws, `/${limit.id}`), { scope: { type: 'member', id: 'nobody' } })).status).toBe(400)
    expect((await owner.agent.del(limitsPath(ws, `/${limit.id}`))).status).toBe(204)
    expect((await owner.agent.patch(limitsPath(ws, `/${limit.id}`), { amount: 1 })).status).toBe(404)
    expect((await auditOf(ws, 'limit.')).slice(-3)).toEqual([
      { action: 'limit.create', target: limit.id, data: JSON.stringify({ name: 'Pages' }) },
      { action: 'limit.update', target: limit.id, data: JSON.stringify({ fields: ['amount', 'enabled'] }) },
      { action: 'limit.delete', target: limit.id, data: JSON.stringify({ name: 'Pages' }) },
    ])
  })

  it('refuse bad scopes, cycles, units, amounts and unknown fields', async () => {
    const bad: object[] = [
      { scope: { type: 'everyone' } },
      { scope: { type: 'member' } },
      { scope: { type: 'member', id: 'nobody' } },
      { scope: { type: 'group', id: 'nobody' } },
      { scope: { type: 'device', id: 'nobody' } },
      { scope: { type: 'printer', id: 'nobody' } },
      { scope: { type: 'workspace', id: 'x' } },
      { cycle: { kind: 'fortnight' } },
      { cycle: { kind: 'week', firstDay: 7 } },
      { cycle: { kind: 'month', startDay: 29 } },
      { cycle: { kind: 'month', startDay: 0 } },
      { cycle: { kind: 'quarter', startMonth: 13 } },
      { cycle: { kind: 'day', startDay: 1 } },
      { unit: 'inches' },
      { amount: -1 },
      { amount: 1.5 },
      { amount: 2_000_000_000_000 },
      { action: 'shout' },
      { name: '' },
      { limit: 3 },
    ]
    for (const body of bad) expect((await owner.agent.post(limitsPath(ws), { name: 'Bad', unit: 'pages', amount: 5, cycle: MONTH, scope: { type: 'workspace' }, ...body })).status, JSON.stringify(body)).toBe(400)
    expect(ok(await owner.agent.get(limitsPath(ws)), 'list')).toEqual([])
  })
})

describe('extra allowances', () => {
  beforeAll(() => turnOnPolicies(owner, ws))

  it('need whose count for limits that keep one each, and none for a shared count', async () => {
    const each = await create({ name: 'Each' })
    const shared = await create({ name: 'Shared', scope: { type: 'workspace' } })
    const devices = await create({ name: 'Devices', scope: { type: 'each-device' } })
    const add = (id: string, body: object) => owner.agent.post(limitsPath(ws, `/${id}/adjustments`), body)
    const refused: [string, object][] = [
      [each.id, { amount: 10 }],
      [each.id, { amount: 10, subject: { type: 'client', id: p.clientId } }],
      [each.id, { amount: 10, subject: { type: 'user', id: 'nobody' } }],
      [each.id, { amount: 0, subject: { type: 'user', id: member.user.id } }],
      [each.id, { amount: 10, subject: { type: 'user', id: member.user.id }, note: 'x'.repeat(201) }],
      [shared.id, { amount: 10, subject: { type: 'user', id: member.user.id } }],
      [devices.id, { amount: 10, subject: { type: 'user', id: member.user.id } }],
      [shared.id, { amount: 10, reason: 'busy week' }],
    ]
    for (const [id, body] of refused) expect((await add(id, body)).status, JSON.stringify(body)).toBe(400)
    expect((await member.agent.post(limitsPath(ws, `/${shared.id}/adjustments`), { amount: 5 })).status).toBe(403)

    const extra = ok(await add(each.id, { amount: 20, subject: { type: 'user', id: member.user.id }, note: 'Exam week' }), 'add')
    expect(extra).toMatchObject({ limitId: each.id, subject: { type: 'user', id: member.user.id }, amount: 20, note: 'Exam week', createdBy: owner.user.id })
    ok(await add(shared.id, { amount: 5 }), 'add shared')
    ok(await add(devices.id, { amount: 3, subject: { type: 'client', id: p.clientId } }), 'add device')
    expect(ok(await owner.agent.get(limitsPath(ws, `/${each.id}/adjustments`)), 'list')).toEqual([extra])
    expect((await auditOf(ws, 'limit.adjust')).at(0)).toMatchObject({ target: each.id })

    const views = ok(await owner.agent.get(limitsPath(ws)), 'views')
    const usageOf = (id: string) => views.find((l: { id: string }) => l.id === id).usage
    expect(usageOf(each.id).find((u: { subject: { id: string } }) => u.subject.id === member.user.id)).toMatchObject({ amount: 70, used: 0, left: 70 })
    expect(usageOf(each.id).find((u: { subject: { id: string } }) => u.subject.id === owner.user.id)).toMatchObject({ amount: 50 })
    expect(usageOf(shared.id)).toEqual([expect.objectContaining({ subject: null, amount: 55 })])
    expect(usageOf(devices.id).find((u: { subject: { id: string } }) => u.subject.id === p.clientId)).toMatchObject({ amount: 53, subjectName: expect.any(String) })
    for (const l of [each, shared, devices]) await owner.agent.del(limitsPath(ws, `/${l.id}`))
  })
})
