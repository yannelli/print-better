import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCron } from '../worker/cron'
import { newGroup, ok, turnOnAccess, wsPath } from './helpers/access'
import { auditOf, code, giveEmail, outbox, quietPrinter, turnOnEnterprise, type SentMail } from './helpers/enterprise'
import { freshWorkspace } from './helpers/jobs'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let ws: string
let bob: Person
let printer: string
let mail: SentMail[]

const NOV = (day: number, hour = 12) => Date.UTC(2026, 10, day, hour)

async function entry(at: number, fields: { user?: string | null; printer?: string | null; cost?: number; pages?: number; source?: string; costCenter?: string | null }) {
  await env.DB.prepare(
    `INSERT INTO usage_entries (workspace_id, job_id, attempt, at, source, user_id, printer_id, cost_center_id, jobs, pages, sheets, color_pages, cost_micros, estimated)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, 0)`,
  )
    .bind(ws, crypto.randomUUID(), at, fields.source ?? 'web', fields.user ?? null, fields.printer ?? null, fields.costCenter ?? null, fields.pages ?? 1, fields.pages ?? 1, fields.cost ?? 0)
    .run()
}

beforeAll(async () => {
  owner = await setupOwner()
  ws = await freshWorkspace(owner, 'Reports')
  bob = await addMember(owner, 'member', ws)
  await turnOnAccess(owner, ws)
  await turnOnEnterprise(owner, ws, { reports: { enabled: true } })
  printer = await quietPrinter(owner, ws)
  await newGroup(owner.agent, ws, 'Design', [{ type: 'user', id: bob.user.id }])
  await newGroup(owner.agent, ws, 'Print, Inc', [{ type: 'user', id: bob.user.id }])
  await entry(NOV(2), { user: bob.user.id, printer, pages: 3, cost: 75_000 })
  await entry(NOV(3), { user: bob.user.id, printer, pages: 2, cost: 50_000, source: 'mcp' })
  await entry(NOV(3), { user: owner.user.id, printer, pages: 10, cost: 12_500_000 })
  await entry(Date.UTC(2026, 9, 31, 23), { user: owner.user.id, pages: 100 })
  await giveEmail(owner.user.id, 'owner@example.com')
  mail = await outbox(owner)
})
afterAll(() => vi.restoreAllMocks())

const report = (query: string, agent = owner.agent) => agent.get(wsPath(ws, `/reports/usage?${query}`))

describe('usage reports', () => {
  it('group usage by member for local dates, with totals and one entry per day', async () => {
    const r = ok(await report('by=member&from=2026-11-01&to=2026-11-30'), 'report')
    expect(r).toMatchObject({ by: 'member', from: '2026-11-01', to: '2026-11-30', currency: 'USD' })
    expect(r.rows).toEqual([
      { key: owner.user.id, name: 'Olive Owner', jobs: 1, pages: 10, sheets: 10, colorPages: 0, costMicros: 12_500_000 },
      { key: bob.user.id, name: bob.user.name, jobs: 2, pages: 5, sheets: 5, colorPages: 0, costMicros: 125_000 },
    ])
    expect(r.totals).toEqual({ jobs: 3, pages: 15, sheets: 15, colorPages: 0, costMicros: 12_625_000 })
    expect(r.days).toHaveLength(30)
    expect(r.days[2]).toEqual({ day: '2026-11-03', jobs: 2, pages: 12, sheets: 12, colorPages: 0, costMicros: 12_550_000 })
  })

  it('count a member in two groups in both, and name sources', async () => {
    const groups = ok(await report('by=group&from=2026-11-01&to=2026-11-30'), 'groups')
    expect(groups.rows.map((r: { name: string; pages: number }) => [r.name, r.pages])).toEqual([
      ['No group', 10],
      ['Design', 5],
      ['Print, Inc', 5],
    ])
    expect(groups.totals.pages).toBe(15)
    const sources = ok(await report('by=source&from=2026-11-01&to=2026-11-30'), 'sources')
    expect(sources.rows.map((r: { name: string }) => r.name)).toEqual(['Web app', 'AI assistant'])
  })

  it('export CSV with a header row, RFC 4180 quoting and decimal cost, audited', async () => {
    const res = await owner.agent.fetch(wsPath(ws, '/reports/usage?by=group&from=2026-11-01&to=2026-11-30&format=csv'))
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="usage-by-group-2026-11-01-to-2026-11-30.csv"')
    const lines = (await res.text()).split('\r\n')
    expect(lines[0]).toBe('name,key,jobs,pages,sheets,colorPages,cost')
    expect(lines[1]).toBe('No group,,1,10,10,0,12.50')
    expect(lines[3]).toMatch(/^"Print, Inc",[^,]+,2,5,5,0,0\.125$/)
    expect(await auditOf(ws, 'report.export')).toHaveLength(1)
  })

  it('are for admins, and refuse bad dimensions and dates', async () => {
    expect(code(await report('by=member', bob.agent))).toEqual([403, 'forbidden'])
    expect(code(await report('by=colour'))).toEqual([400, 'invalid_request'])
    expect(code(await report('by=member&from=2026-02-30'))).toEqual([400, 'invalid_request'])
    expect(code(await report('by=member&from=2026-11-30&to=2026-11-01'))).toEqual([400, 'invalid_request'])
  })
})

describe('audit export', () => {
  it('writes the audit log for a date range as CSV, for owners and admins', async () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(code(await bob.agent.get(wsPath(ws, `/audit/export?from=${today}&to=${today}`)))).toEqual([403, 'forbidden'])
    const res = await owner.agent.fetch(wsPath(ws, `/audit/export?from=${today}&to=${today}`))
    const lines = (await res.text()).trim().split('\r\n')
    expect(lines[0]).toBe('time,actorType,actorId,actorName,action,target,data')
    expect(lines.some((l) => l.includes(',group.create,'))).toBe(true)
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z,user,/)
    expect(await auditOf(ws, 'audit.export')).toHaveLength(1)
  })
})

describe('scheduled reports', () => {
  it('are created for members, run at 08:00 on the first day of each cycle, and can be deleted', async () => {
    const body = { name: 'Monthly by printer', by: 'printer', cycle: { kind: 'month' }, recipients: [owner.user.id] }
    expect(code(await owner.agent.post(wsPath(ws, '/reports/schedules'), { ...body, cycle: { kind: 'day' } }))).toEqual([400, 'invalid_request'])
    expect(code(await owner.agent.post(wsPath(ws, '/reports/schedules'), { ...body, recipients: ['nobody'] }))).toEqual([400, 'invalid_request'])
    const schedule = ok(await owner.agent.post(wsPath(ws, '/reports/schedules'), body), 'schedule')
    const next = new Date(schedule.nextRunAt)
    expect([next.getUTCDate(), next.getUTCHours(), next.getUTCMinutes()]).toEqual([1, 8, 0])
    expect(ok(await owner.agent.get(wsPath(ws, '/reports/schedules')), 'list')).toEqual([schedule])
    expect((await owner.agent.del(wsPath(ws, `/reports/schedules/${schedule.id}`))).status).toBe(204)
    expect(await auditOf(ws, 'report.schedule_create')).toHaveLength(1)
    expect(await auditOf(ws, 'report.schedule_delete')).toHaveLength(1)
  })

  it('email the cycle that ended, with every row in the attached CSV', async () => {
    const schedule = ok(await owner.agent.post(wsPath(ws, '/reports/schedules'), { name: 'Monthly', by: 'member', cycle: { kind: 'month' }, recipients: [owner.user.id, bob.user.id] }), 'schedule')
    await env.DB.prepare('UPDATE report_schedules SET next_run_at = ? WHERE id = ?').bind(Date.UTC(2026, 10, 1, 8), schedule.id).run()
    await runCron(env)
    const sent = mail.find((m) => m.subject === 'Monthly: 2026-10-01 to 2026-10-31')
    expect(sent?.to).toEqual(['owner@example.com'])
    expect(sent?.text).toContain('Total: 1 job, 100 pages')
    expect(sent?.text).toContain(`/w/${ws}/usage/reports`)
    const csv = new TextDecoder().decode(Uint8Array.from(atob(sent?.attachments?.[0].content ?? ''), (c) => c.charCodeAt(0)))
    expect(sent?.attachments?.[0]).toMatchObject({ filename: 'usage-by-member-2026-10-01-to-2026-10-31.csv', content_type: 'text/csv; charset=utf-8' })
    expect(csv.split('\r\n')[1]).toBe(`Olive Owner,${owner.user.id},1,100,100,0,0.00`)
    const after = ok(await owner.agent.get(wsPath(ws, '/reports/schedules')), 'list').find((s: { id: string }) => s.id === schedule.id)
    expect(after.lastRunAt).not.toBeNull()
    expect(after.nextRunAt).toBeGreaterThan(Date.now())
    expect(await auditOf(ws, 'report.send')).toEqual([expect.objectContaining({ target: schedule.id, actor_type: 'system' })])
  })
})
