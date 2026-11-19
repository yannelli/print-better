import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_ENTERPRISE_SETTINGS } from '../shared/enterprise'
import { ok, wsPath } from './helpers/access'
import { code, job, quietPrinter, setEnterprise, turnOnEnterprise } from './helpers/enterprise'
import type { Agent, Reply } from './helpers/http'
import { freshWorkspace } from './helpers/jobs'
import { modern } from './helpers/mcp'
import { addMember, createPat, setupOwner, type Owner } from './helpers/world'

let owner: Owner

beforeAll(async () => {
  owner = await setupOwner()
})

/** Every route in docs/enterprise.md, with the part that gates it (null: the extension alone). */
const ROUTES: [method: 'get' | 'post' | 'patch' | 'put' | 'del', path: string, part: string | null][] = [
  ['get', '/enterprise', null],
  ['patch', '/enterprise', null],
  ['patch', '/printers/p/enterprise', null],
  ['get', '/approvals', 'approvals'],
  ['post', '/jobs/j/approve', 'approvals'],
  ['post', '/jobs/j/deny', 'approvals'],
  ['get', '/release', 'release'],
  ['post', '/jobs/j/release', 'release'],
  ['post', '/release/all', 'release'],
  ['get', '/cost-centers', 'costCenters'],
  ['post', '/cost-centers', 'costCenters'],
  ['patch', '/cost-centers/c', 'costCenters'],
  ['del', '/cost-centers/c', 'costCenters'],
  ['get', '/cost-centers/defaults', 'costCenters'],
  ['put', '/cost-centers/defaults', 'costCenters'],
  ['get', '/budgets', 'costCenters'],
  ['post', '/budgets', 'costCenters'],
  ['patch', '/budgets/b', 'costCenters'],
  ['del', '/budgets/b', 'costCenters'],
  ['get', '/reports/usage?by=member', 'reports'],
  ['get', '/reports/schedules', 'reports'],
  ['post', '/reports/schedules', 'reports'],
  ['del', '/reports/schedules/s', 'reports'],
  ['get', '/audit/export', 'reports'],
]

const hit = (agent: Agent, ws: string, method: (typeof ROUTES)[number][0], path: string): Promise<Reply> =>
  method === 'get' || method === 'del' ? agent[method](wsPath(ws, path)) : agent[method](wsPath(ws, path), {})

describe('Enterprise controls off', () => {
  it('answers 404 extension_inactive on every route, and keeps held out of job filters', async () => {
    const ws = await freshWorkspace(owner, 'Off')
    for (const [method, path] of ROUTES) expect(code(await hit(owner.agent, ws, method, path)), `${method} ${path}`).toEqual([404, 'extension_inactive'])
    expect(code(await owner.agent.get(wsPath(ws, '/jobs?status=held')))).toEqual([400, 'invalid_request'])
  })

  it('leaves jobs exactly as they were: queued, without hold, cost center or notes', async () => {
    const ws = await freshWorkspace(owner, 'Untouched')
    const printer = await quietPrinter(owner, ws)
    const before = ok(await job(owner.agent, ws, printer), 'job').job
    expect(before).not.toHaveProperty('held')
    expect(before).not.toHaveProperty('usage')
    await turnOnEnterprise(owner, ws)
    const after = ok(await job(owner.agent, ws, printer, { costCenter: 'anything' }), 'job').job
    expect(after).toMatchObject({ status: 'queued', statusMessage: null })
    for (const key of ['held', 'costCenterId', 'policy']) expect(after).not.toHaveProperty(key)
  })
})

describe('turned on with every part off', () => {
  let ws: string
  beforeAll(async () => {
    ws = await freshWorkspace(owner, 'Parts')
    await turnOnEnterprise(owner, ws)
  })

  it('shows members the default settings and no printers with controls', async () => {
    const member = await addMember(owner, 'member', ws)
    expect(ok(await member.agent.get(wsPath(ws, '/enterprise')), 'config')).toEqual({ settings: DEFAULT_ENTERPRISE_SETTINGS, printers: {} })
  })

  it('answers 409 part_off on each part’s routes', async () => {
    for (const [method, path, part] of ROUTES.filter((r) => r[2] !== null)) {
      const reply = await hit(owner.agent, ws, method, path)
      expect(code(reply), `${method} ${path}`).toEqual([409, 'part_off'])
      expect(reply.body.error.message, part as string).toContain('is turned off')
    }
  })

  it('needs a part on before a printer can use it', async () => {
    const printer = await quietPrinter(owner, ws)
    expect(code(await owner.agent.patch(wsPath(ws, `/printers/${printer}/enterprise`), { approval: true }))).toEqual([409, 'part_off'])
    await setEnterprise(owner.agent, ws, { approvals: { enabled: true } })
    expect(ok(await owner.agent.patch(wsPath(ws, `/printers/${printer}/enterprise`), { approval: true }), 'controls')).toEqual({ approval: true, secureRelease: false })
    expect(code(await owner.agent.patch(wsPath(ws, `/printers/${printer}/enterprise`), { secureRelease: true }))).toEqual([409, 'part_off'])
    expect(code(await owner.agent.patch(wsPath(ws, `/printers/${printer}/enterprise`), { color: true }))).toEqual([400, 'invalid_request'])
  })

  it('accepts status=held in job lists', async () => {
    expect(ok(await owner.agent.get(wsPath(ws, '/jobs?status=held')), 'held').items).toEqual([])
  })
})

describe('settings', () => {
  it('validate every part, merge updates, and keep privacy for owners', async () => {
    const ws = await freshWorkspace(owner, 'Settings')
    await turnOnEnterprise(owner, ws)
    const admin = await addMember(owner, 'admin', ws)
    const member = await addMember(owner, 'member', ws)
    const bad = [{ approvals: { expiryHours: 0 } }, { release: { enabled: 'yes' } }, { colour: {} }, { reports: { extra: true } }, { alerts: { recipients: ['nobody'] } }]
    for (const body of bad) expect((await admin.agent.patch(wsPath(ws, '/enterprise'), body)).status, JSON.stringify(body)).toBe(400)
    expect(code(await member.agent.patch(wsPath(ws, '/enterprise'), { reports: { enabled: true } }))).toEqual([403, 'forbidden'])
    expect(code(await admin.agent.patch(wsPath(ws, '/enterprise'), { privacy: { enabled: true } }))).toEqual([403, 'forbidden'])
    const saved = await setEnterprise(admin.agent, ws, { approvals: { enabled: true }, alerts: { recipients: [admin.user.id] } })
    expect(saved.settings.approvals).toEqual({ enabled: true, expiryHours: 24 })
    expect(saved.settings.alerts.recipients).toEqual([admin.user.id])
    expect((await setEnterprise(owner.agent, ws, { privacy: { enabled: true, ownerOnlyNames: true } })).settings.privacy).toMatchObject({ enabled: true, ownerOnlyNames: true })
  })
})

describe('MCP', () => {
  it('lists the tools while the extension is available, and widens print and list_jobs', async () => {
    const token = await createPat(owner)
    const names = async () => ((await modern(token, 'tools/list')).body.result.tools as { name: string }[]).map((t) => t.name)
    ok(await owner.agent.patch('/api/admin/extensions/enterprise', { available: false }), 'unavailable')
    expect(await names()).not.toContain('list_approvals')
    expect(await names()).not.toContain('get_prices')
    ok(await owner.agent.patch('/api/admin/extensions/enterprise', { available: true }), 'available')
    const tools = (await modern(token, 'tools/list')).body.result.tools as { name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }[]
    const listed = tools.map((t) => t.name)
    for (const name of ['list_approvals', 'approve_job', 'deny_job', 'list_ready_to_release', 'release_job', 'list_cost_centers', 'create_cost_center', 'update_cost_center', 'delete_cost_center', 'set_cost_center_defaults', 'list_budgets', 'create_budget', 'update_budget', 'delete_budget', 'usage_report', 'get_enterprise_settings', 'update_enterprise_settings', 'set_printer_controls', 'get_prices', 'set_prices', 'preview_print_job']) {
      expect(listed, name).toContain(name)
    }
    expect(listed.filter((n) => n === 'get_prices')).toHaveLength(1)
    expect(tools.find((t) => t.name === 'print')?.inputSchema.properties).toHaveProperty('costCenter')
    expect(tools.find((t) => t.name === 'list_jobs')?.inputSchema.properties.status.enum).toContain('held')
  })
})
