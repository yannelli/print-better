import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ok } from './helpers/access'
import { callTool, modern } from './helpers/mcp'
import { addMember, createPat, setupOwner, type Owner, type Person } from './helpers/world'
import { office, type Office, switchExtension, turnOnPolicies } from './helpers/usage'

const TOOLS = [
  'list_print_rules',
  'create_print_rule',
  'update_print_rule',
  'delete_print_rule',
  'reorder_print_rules',
  'list_print_limits',
  'create_print_limit',
  'update_print_limit',
  'delete_print_limit',
  'add_limit_allowance',
  'get_my_usage',
  'get_usage',
]

let owner: Owner
let member: Person
let ws: string
let p: Office
let admin: string
let mine: string

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  member = await addMember(owner)
  p = await office(owner, ws)
  admin = await createPat(owner, ws)
  mine = await createPat(member, ws)
})
afterAll(() => p.device.close())

const listed = async (token: string) => ((await modern(token, 'tools/list')).body.result.tools as { name: string }[]).map((t) => t.name)

describe('print rules and limits over MCP', () => {
  it('lists the tools only while the extension is available, and explains when it is off here', async () => {
    expect(await listed(admin)).not.toEqual(expect.arrayContaining([TOOLS[0]]))
    ok(await owner.agent.patch('/api/admin/extensions/print-policies', { available: true }), 'available')
    expect(await listed(admin)).toEqual(expect.arrayContaining(TOOLS))
    const off = await callTool(admin, 'list_print_rules')
    expect(off.isError).toBe(true)
    expect(off.summary).toContain('Print rules and limits is turned off for this workspace')
  })

  it('manages rules and describes them in order', async () => {
    await turnOnPolicies(owner, ws)
    const big = await callTool(admin, 'create_print_rule', {
      name: 'Big jobs on both sides',
      conditions: { pages: { min: 10 }, color: true },
      actions: [{ type: 'two-sided' }, { type: 'note', message: 'Saved paper' }],
    })
    expect(big.isError).toBe(false)
    expect(big.summary).toBe(`Created Big jobs on both sides (${big.data.rule.id}): 10 pages or more; In color. Then: Print two-sided; Add a note: Saved paper.`)
    const night = await callTool(admin, 'create_print_rule', {
      name: 'Nights',
      enabled: false,
      conditions: { time: { days: [1, 2, 3, 4, 5], from: '18:00', to: '08:00' }, printers: [p.color] },
      actions: [{ type: 'redirect', printerId: p.mono }],
    })
    expect(night.summary).toContain(`, off: To printer ${p.color}; Mon to Fri, 18:00 to 08:00. Then: Send to printer ${p.mono}.`)
    const order = await callTool(admin, 'reorder_print_rules', { ids: [night.data.rule.id, big.data.rule.id] })
    expect(order.summary.split('\n').map((line) => line.slice(0, 9))).toEqual(['1. Nights', '2. Big jo'])
    expect((await callTool(admin, 'update_print_rule', { ruleId: night.data.rule.id, enabled: true })).data.rule.enabled).toBe(true)
    expect((await callTool(admin, 'create_print_rule', { name: 'Bad', actions: [{ type: 'shred' }] })).isError).toBe(true)
    expect((await callTool(mine, 'list_print_rules')).summary).toContain('Only admins can do that')
    for (const id of [big.data.rule.id, night.data.rule.id]) expect((await callTool(admin, 'delete_print_rule', { ruleId: id })).isError).toBe(false)
    expect((await callTool(admin, 'list_print_rules')).summary).toBe('No rules yet.')
  })

  it('refuses a print job with the rule’s message', async () => {
    const rule = await callTool(admin, 'create_print_rule', { name: 'Closed', actions: [{ type: 'block', message: 'The office is closed today.' }] })
    const refused = await callTool(mine, 'print', { printerId: p.color, text: 'Hello' })
    expect(refused.isError).toBe(true)
    expect(refused.summary).toContain('The office is closed today.')
    await callTool(admin, 'delete_print_rule', { ruleId: rule.data.rule.id })
  })

  it('manages limits, extra allowances and usage', async () => {
    const created = await callTool(admin, 'create_print_limit', {
      name: 'Monthly pages',
      scope: { type: 'each-member' },
      unit: 'pages',
      amount: 50,
      cycle: { kind: 'month', startDay: 1 },
    })
    const id = created.data.limit.id
    expect(created.summary).toBe(`Created Monthly pages (${id}): Each member, 50 pages a month, then blocks.`)
    expect((await callTool(mine, 'print', { printerId: p.mono, text: 'One page' })).isError).toBe(false)
    const extra = await callTool(admin, 'add_limit_allowance', { limitId: id, amount: 10, subject: { type: 'user', id: member.user.id }, note: 'Exam week' })
    expect(extra.summary).toBe(`Added 10 to limit ${id} for this cycle.`)
    expect((await callTool(mine, 'get_my_usage')).summary).toMatch(/^Monthly pages: 59 of 60 pages left, starts over \d{4}-\d\d-\d\dT/)
    const usage = await callTool(admin, 'get_usage')
    expect(usage.summary.split('\n')).toEqual(expect.arrayContaining([`Monthly pages (${id}): Each member, 50 pages a month, then blocks`, expect.stringMatching(/: 1 page used, 59 of 60 pages left$/)]))
    expect((await callTool(admin, 'get_usage', { cycle: 'previous' })).summary).toContain('0 pages used, 50 of 50 pages left')
    expect((await callTool(admin, 'update_print_limit', { limitId: id, action: 'warn' })).summary).toContain('then warns')
    expect((await callTool(admin, 'list_print_limits')).data.limits).toHaveLength(1)
    expect((await callTool(admin, 'delete_print_limit', { limitId: id })).summary).toBe(`Deleted limit ${id}.`)
    expect((await callTool(mine, 'get_my_usage')).summary).toBe('No limits count your jobs.')
  })

  it('stops listing the tools once the extension is no longer available', async () => {
    await switchExtension(owner, 'print-policies', ws, false)
    ok(await owner.agent.patch('/api/admin/extensions/print-policies', { available: false }), 'unavailable')
    expect(await listed(admin)).not.toEqual(expect.arrayContaining([TOOLS[0]]))
  })
})
