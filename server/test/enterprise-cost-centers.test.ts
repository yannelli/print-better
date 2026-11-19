import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { newGroup, ok, turnOnAccess, wsPath } from './helpers/access'
import { auditOf, code, job, quietPrinter, setControls, setEnterprise, turnOnEnterprise } from './helpers/enterprise'
import { freshWorkspace } from './helpers/jobs'
import { pdfJob } from './helpers/usage'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let ws: string
let bob: Person
let printer: string

beforeAll(async () => {
  owner = await setupOwner()
  ws = await freshWorkspace(owner, 'Charging')
  bob = await addMember(owner, 'member', ws)
  await turnOnAccess(owner, ws)
  await turnOnEnterprise(owner, ws, { costCenters: { enabled: true }, approvals: { enabled: true } })
  printer = await quietPrinter(owner, ws)
})

const center = async (name: string, code: string | null = null) => ok(await owner.agent.post(wsPath(ws, '/cost-centers'), { name, code }), 'cost center')

describe('cost centers', () => {
  it('are created by admins, read by members, and keep names and codes unique', async () => {
    const marketing = await center('Marketing', 'MKT')
    expect(marketing).toMatchObject({ name: 'Marketing', code: 'MKT', active: true })
    expect(code(await bob.agent.post(wsPath(ws, '/cost-centers'), { name: 'Mine' }))).toEqual([403, 'forbidden'])
    expect(code(await owner.agent.post(wsPath(ws, '/cost-centers'), { name: 'marketing' }))).toEqual([409, 'name_taken'])
    expect(code(await owner.agent.post(wsPath(ws, '/cost-centers'), { name: 'Other', code: 'mkt' }))).toEqual([409, 'name_taken'])
    expect(ok(await bob.agent.get(wsPath(ws, '/cost-centers')), 'list').costCenters.map((c: { name: string }) => c.name)).toContain('Marketing')
    expect(await auditOf(ws, 'cost_center.create')).toContainEqual(expect.objectContaining({ target: marketing.id }))
  })

  it('charge the picked one by id or code, and refuse unknown or inactive ones', async () => {
    const sales = await center('Sales', 'S-1')
    expect(ok(await job(bob.agent, ws, printer, { costCenter: 's-1' }), 'job').job.costCenterId).toBe(sales.id)
    expect(ok(await job(bob.agent, ws, printer, { costCenter: sales.id }), 'job').job.costCenterId).toBe(sales.id)
    expect(code(await job(bob.agent, ws, printer, { costCenter: 'nope' }))).toEqual([400, 'cost_center_invalid'])
    ok(await owner.agent.patch(wsPath(ws, `/cost-centers/${sales.id}`), { active: false }), 'deactivate')
    expect(code(await job(bob.agent, ws, printer, { costCenter: sales.id }))).toEqual([400, 'cost_center_invalid'])
  })

  it('can be deleted only until a job is charged to them', async () => {
    const used = await center('Used')
    ok(await job(bob.agent, ws, printer, { costCenter: used.id }), 'job')
    expect(code(await owner.agent.del(wsPath(ws, `/cost-centers/${used.id}`)))).toEqual([409, 'cost_center_in_use'])
    const unused = await center('Unused')
    expect((await owner.agent.del(wsPath(ws, `/cost-centers/${unused.id}`))).status).toBe(204)
    expect(await auditOf(ws, 'cost_center.delete')).toContainEqual(expect.objectContaining({ target: unused.id }))
  })
})

describe('defaults', () => {
  it('pick the member’s, then their first group’s by name, then the device’s', async () => {
    const [mine, groupA, groupB] = [await center('Mine'), await center('Group A'), await center('Group B')]
    const b = await newGroup(owner.agent, ws, 'B team', [{ type: 'user', id: bob.user.id }])
    const a = await newGroup(owner.agent, ws, 'A team', [{ type: 'user', id: bob.user.id }])
    const saved = ok(await owner.agent.put(wsPath(ws, '/cost-centers/defaults'), { groups: { [a]: groupA.id, [b]: groupB.id } }), 'defaults')
    expect(saved.groups).toEqual({ [a]: groupA.id, [b]: groupB.id })
    expect(ok(await job(bob.agent, ws, printer), 'job').job.costCenterId).toBe(groupA.id)
    ok(await owner.agent.put(wsPath(ws, '/cost-centers/defaults'), { members: { [bob.user.id]: mine.id } }), 'member default')
    expect(ok(await job(bob.agent, ws, printer), 'job').job.costCenterId).toBe(mine.id)
    expect(ok(await bob.agent.get(wsPath(ws, '/cost-centers')), 'list').myDefault).toBe(mine.id)
    const cleared = ok(await owner.agent.put(wsPath(ws, '/cost-centers/defaults'), { members: { [bob.user.id]: null } }), 'clear')
    expect(cleared.members).toEqual({})
    expect(code(await owner.agent.put(wsPath(ws, '/cost-centers/defaults'), { members: { nobody: mine.id } }))).toEqual([400, 'invalid_request'])
    expect(code(await bob.agent.get(wsPath(ws, '/cost-centers/defaults')))).toEqual([403, 'forbidden'])
    expect(await auditOf(ws, 'cost_center.defaults')).toHaveLength(3)
  })

  it('refuses jobs without one when every job needs a cost center, except test pages', async () => {
    const strict = await freshWorkspace(owner, 'Strict')
    await turnOnEnterprise(owner, strict, { costCenters: { enabled: true, required: true } })
    const p = await quietPrinter(owner, strict)
    const refused = await job(owner.agent, strict, p)
    expect(code(refused)).toEqual([403, 'policy_blocked'])
    expect(refused.body.error.message).toBe('Choose a cost center to charge this job to')
    expect(await auditOf(strict, 'job.block')).toHaveLength(1)
    expect(ok(await owner.agent.post(wsPath(strict, `/printers/${p}/test-page`)), 'test page').job.status).toBe('queued')
  })
})

describe('budgets', () => {
  let ops: string
  beforeAll(async () => {
    ops = (await center('Operations', 'OPS')).id
  })

  const budget = async (body: Record<string, unknown>) => ok(await owner.agent.post(wsPath(ws, '/budgets'), { costCenterId: ops, cycle: { kind: 'month' }, ...body }), 'budget')

  it('are validated, listed with this cycle’s usage, and audited', async () => {
    expect(code(await owner.agent.post(wsPath(ws, '/budgets'), { costCenterId: 'nope', unit: 'pages', amount: 1, cycle: { kind: 'month' } }))).toEqual([400, 'cost_center_invalid'])
    expect(code(await owner.agent.post(wsPath(ws, '/budgets'), { costCenterId: ops, unit: 'jobs', amount: 1, cycle: { kind: 'month' } }))).toEqual([400, 'invalid_request'])
    expect(code(await owner.agent.post(wsPath(ws, '/budgets'), { costCenterId: ops, unit: 'pages', amount: 1, cycle: { kind: 'month', startDay: 29 } }))).toEqual([400, 'invalid_request'])
    const created = await budget({ unit: 'pages', amount: 1000, enabled: false })
    expect(created).toMatchObject({ unit: 'pages', amount: 1000, action: 'block', cycle: { kind: 'month', startDay: 1 }, usage: { used: 0, left: 1000 } })
    expect(ok(await owner.agent.get(wsPath(ws, '/budgets')), 'list').map((b: { id: string }) => b.id)).toContain(created.id)
    expect(code(await bob.agent.get(wsPath(ws, '/budgets')))).toEqual([403, 'forbidden'])
    expect(ok(await owner.agent.patch(wsPath(ws, `/budgets/${created.id}`), { amount: 5 }), 'update').amount).toBe(5)
    expect((await owner.agent.del(wsPath(ws, `/budgets/${created.id}`))).status).toBe(204)
    for (const action of ['budget.create', 'budget.update', 'budget.delete']) expect(await auditOf(ws, action), action).toHaveLength(1)
  })

  it('block, warn, or ask for approval when a job would go over', async () => {
    const limit = await budget({ unit: 'pages', amount: 5 })
    ok(await pdfJob(bob.agent, ws, printer, 3, {}, { costCenter: ops }), 'within')
    const blocked = await pdfJob(bob.agent, ws, printer, 3, {}, { costCenter: ops })
    expect(code(blocked)).toEqual([403, 'policy_blocked'])
    expect(blocked.body.error.message).toBe('This job would go over the Operations monthly budget')
    ok(await owner.agent.patch(wsPath(ws, `/budgets/${limit.id}`), { action: 'warn' }), 'warn')
    const warned = ok(await pdfJob(bob.agent, ws, printer, 3, {}, { costCenter: ops }), 'warned').job
    expect(warned.policy.notes).toContainEqual({ source: 'budget', id: limit.id, name: 'Operations monthly budget', message: 'Over the Operations monthly budget' })
    ok(await owner.agent.patch(wsPath(ws, `/budgets/${limit.id}`), { action: 'approval' }), 'approval')
    const held = ok(await pdfJob(bob.agent, ws, printer, 1, {}, { costCenter: ops }), 'held').job
    expect(held).toMatchObject({ status: 'held', held: { kind: 'approval', reasons: ['Over the Operations monthly budget'] } })
    await setEnterprise(owner.agent, ws, { approvals: { enabled: false } })
    expect(code(await pdfJob(bob.agent, ws, printer, 1, {}, { costCenter: ops }))).toEqual([403, 'policy_blocked'])
    const view = ok(await owner.agent.get(wsPath(ws, '/budgets')), 'list').find((b: { id: string }) => b.id === limit.id)
    expect(view.usage).toMatchObject({ unit: 'pages', used: 6, amount: 5, left: 0 })
    await env.DB.prepare('DELETE FROM budgets WHERE id = ?').bind(limit.id).run()
    await setEnterprise(owner.agent, ws, { approvals: { enabled: true } })
    await setControls(owner.agent, ws, printer, { approval: false })
  })

  it('let jobs sent at the same moment through only as far as a blocking budget has room', async () => {
    const shared = (await center('Shared')).id
    ok(await owner.agent.post(wsPath(ws, '/budgets'), { costCenterId: shared, unit: 'pages', amount: 10, cycle: { kind: 'month' } }), 'budget')
    const replies = await Promise.all(Array.from({ length: 8 }, () => pdfJob(bob.agent, ws, printer, 10, {}, { costCenter: shared })))
    expect(replies.map((r) => r.status).sort()).toEqual([200, 403, 403, 403, 403, 403, 403, 403])
    for (const refused of replies.filter((r) => r.status === 403)) {
      expect(refused.body.error).toMatchObject({ code: 'policy_blocked', message: 'This job would go over the Shared monthly budget' })
    }
    const view = ok(await owner.agent.get(wsPath(ws, '/budgets')), 'list').find((b: { costCenterId: string }) => b.costCenterId === shared)
    expect(view.usage).toMatchObject({ used: 10, left: 0 })
  })
})
