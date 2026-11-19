import { beforeAll, describe, expect, it } from 'vitest'
import { quietPrinter, turnOnEnterprise } from './helpers/enterprise'
import { freshWorkspace } from './helpers/jobs'
import { callTool } from './helpers/mcp'
import { addMember, createPat, setupOwner, type Owner } from './helpers/world'

let owner: Owner
let ws: string
let token: string
let printer: string

beforeAll(async () => {
  owner = await setupOwner()
  ws = await freshWorkspace(owner, 'Assistant')
  token = await createPat(owner)
  await turnOnEnterprise(owner, ws)
  printer = await quietPrinter(owner, ws)
})

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await callTool(token, name, { workspaceId: ws, ...args })
  if (result.isError) throw new Error(`${name}: ${result.summary}`)
  return result
}

describe('enterprise MCP tools', () => {
  it('change settings and printer controls through the same rules', async () => {
    const off = await callTool(token, 'list_approvals', { workspaceId: ws })
    expect(off.isError).toBe(true)
    expect(off.summary).toContain('Approvals is turned off')
    const saved = await call('update_enterprise_settings', { approvals: { enabled: true }, release: { enabled: true }, costCenters: { enabled: true }, reports: { enabled: true } })
    expect(saved.data.config.settings.approvals.enabled).toBe(true)
    expect((await call('get_enterprise_settings')).summary).toContain('approvals: on')
    expect((await call('set_printer_controls', { printerId: printer, approval: true })).data.controls).toEqual({ approval: true, secureRelease: false })
  })

  it('print with a cost center, then approve, deny and release', async () => {
    const center = (await call('create_cost_center', { name: 'Research', code: 'RND' })).data.costCenter
    const printed = await call('print', { printerId: printer, text: 'Lab notes', costCenter: 'rnd' })
    expect(printed.data.job).toMatchObject({ status: 'held', costCenterId: center.id })
    expect((await call('list_jobs', { status: 'held' })).data.items.map((j: { id: string }) => j.id)).toContain(printed.data.job.id)
    expect((await call('list_approvals')).data.jobs.map((j: { id: string }) => j.id)).toEqual([printed.data.job.id])
    expect((await call('approve_job', { jobId: printed.data.job.id, note: 'ok' })).data.job.status).toBe('queued')
    const second = (await call('print', { printerId: printer, text: 'More notes' })).data.job.id
    expect((await call('deny_job', { jobId: second, reason: 'Duplicate' })).data.job.statusMessage).toBe('Not approved: Duplicate')

    await call('set_printer_controls', { printerId: printer, approval: false, secureRelease: true })
    const held = (await call('print', { printerId: printer, text: 'Badge' })).data.job.id
    expect((await call('list_ready_to_release')).data.jobs.map((j: { id: string }) => j.id)).toEqual([held])
    expect((await call('release_job', { jobId: held })).data.job.status).toBe('queued')
    await call('print', { printerId: printer, text: 'One' })
    await call('print', { printerId: printer, text: 'Two' })
    expect((await call('release_job')).data.released).toHaveLength(2)
  })

  it('manage cost centers, defaults and budgets, and report usage', async () => {
    const center = (await call('create_cost_center', { name: 'Facilities' })).data.costCenter
    expect((await call('update_cost_center', { costCenterId: center.id, code: 'FAC' })).data.costCenter.code).toBe('FAC')
    const member = await addMember(owner, 'member', ws)
    expect((await call('set_cost_center_defaults', { members: { [member.user.id]: center.id } })).data.defaults.members).toEqual({ [member.user.id]: center.id })
    const budget = (await call('create_budget', { costCenterId: center.id, unit: 'cost', amount: 5_000_000, cycle: { kind: 'quarter', startMonth: 2 } })).data.budget
    expect(budget).toMatchObject({ unit: 'cost', amount: 5_000_000, cycle: { kind: 'quarter', startMonth: 2 } })
    expect((await call('update_budget', { budgetId: budget.id, action: 'warn' })).data.budget.action).toBe('warn')
    expect((await call('list_budgets')).data.budgets).toHaveLength(1)
    expect((await call('delete_budget', { budgetId: budget.id })).data.removed).toBe(budget.id)
    expect((await call('list_cost_centers')).data.costCenters.map((c: { name: string }) => c.name)).toEqual(['Facilities', 'Research'])
    await call('set_cost_center_defaults', { members: { [member.user.id]: null } })
    expect((await call('delete_cost_center', { costCenterId: center.id })).data.removed).toBe(center.id)
    const report = await call('usage_report', { by: 'cost-center' })
    expect(report.data.report.rows.map((r: { name: string }) => r.name)).toContain('Research')
    expect(report.summary).toMatch(/jobs/)
  })
})
