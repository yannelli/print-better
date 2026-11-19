import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { alertAfterJob } from '../worker/extensions/enterprise/alerts'
import type { JobDraft } from '../worker/extensions/hooks'
import { systemCtx } from '../worker/services/context'
import { ok, wsPath } from './helpers/access'
import { connectPrinter, eventually } from './helpers/device'
import { code, giveEmail, job, outbox, quietPrinter, setEnterprise, turnOnEnterprise, type SentMail } from './helpers/enterprise'
import { EventSocket, freshWorkspace, jobRow } from './helpers/jobs'
import { callTool } from './helpers/mcp'
import { pdfJob, switchExtension } from './helpers/usage'
import { addMember, createPat, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let ws: string
let bob: Person
let printer: string
let mail: SentMail[]

beforeAll(async () => {
  owner = await setupOwner()
  ws = await freshWorkspace(owner, 'Private')
  bob = await addMember(owner, 'member', ws)
  await giveEmail(owner.user.id, 'owner@example.com')
  await giveEmail(bob.user.id, 'bob@example.com')
  await turnOnEnterprise(owner, ws, { privacy: { enabled: true, ownerOnlyNames: true }, costCenters: { enabled: true }, alerts: { enabled: true } })
  printer = await quietPrinter(owner, ws)
  mail = await outbox(owner)
})
afterAll(() => vi.restoreAllMocks())

describe('document names', () => {
  it('show only to the person who printed, everywhere', async () => {
    const id = ok(await job(bob.agent, ws, printer, { title: 'Salary review' }), 'job').job.id
    expect(ok(await bob.agent.get(wsPath(ws, `/jobs/${id}`)), 'own').title).toBe('Salary review')
    expect(ok(await owner.agent.get(wsPath(ws, `/jobs/${id}`)), 'other')).toMatchObject({ title: 'Document', fileName: null })
    expect(ok(await owner.agent.get(wsPath(ws, '/jobs')), 'list').items.find((j: { id: string }) => j.id === id).title).toBe('Document')
    const mcp = await callTool(await createPat(owner), 'get_job', { workspaceId: ws, jobId: id })
    expect(mcp.data.job.title).toBe('Document')
    const events = await EventSocket.open(owner.agent, ws)
    try {
      const next = ok(await job(bob.agent, ws, printer, { title: 'Offer letter' }), 'job').job.id
      expect((await events.next('job', (e) => e.job.id === next)).job.title).toBe('Document')
    } finally {
      events.close()
    }
  })

  it('show to owners and admins when they may see them', async () => {
    const id = ok(await job(bob.agent, ws, printer, { title: 'Budget draft' }), 'job').job.id
    await setEnterprise(owner.agent, ws, { privacy: { adminsSeeNames: true } })
    expect(ok(await owner.agent.get(wsPath(ws, `/jobs/${id}`)), 'admin').title).toBe('Budget draft')
    await setEnterprise(owner.agent, ws, { privacy: { adminsSeeNames: false } })
  })

  it('hide in the audit log, also through MCP', async () => {
    const id = ok(await job(bob.agent, ws, printer, { title: 'Exit interview' }), 'job').job.id
    ok(await owner.agent.post(wsPath(ws, `/jobs/${id}/cancel`)), 'cancel')
    expect((await owner.agent.del(wsPath(ws, `/jobs/${id}`))).status).toBe(204)
    const deleted = (items: { action: string; target: string; data: unknown }[]) => items.find((e) => e.action === 'job.delete' && e.target === id)?.data
    expect(deleted(ok(await owner.agent.get(wsPath(ws, '/audit')), 'audit').items)).toEqual({ title: 'Document' })
    expect(deleted((await callTool(await createPat(owner), 'list_audit', { workspaceId: ws })).data.items)).toEqual({ title: 'Document' })
    await setEnterprise(owner.agent, ws, { privacy: { adminsSeeNames: true } })
    expect(deleted(ok(await owner.agent.get(wsPath(ws, '/audit')), 'audit').items)).toEqual({ title: 'Exit interview' })
    await setEnterprise(owner.agent, ws, { privacy: { adminsSeeNames: false } })
  })
})

describe('retention', () => {
  it('deletes documents as soon as a job finishes, so retry is unavailable', async () => {
    await setEnterprise(owner.agent, ws, { privacy: { deleteWhenFinished: true } })
    const id = ok(await job(bob.agent, ws, printer), 'job').job.id
    expect((await jobRow(id))?.file_key).not.toBeNull()
    const canceled = ok(await bob.agent.post(wsPath(ws, `/jobs/${id}/cancel`)), 'cancel')
    expect(canceled.hasFile).toBe(false)
    expect((await jobRow(id))?.file_key).toBeNull()
    expect(code(await bob.agent.post(wsPath(ws, `/jobs/${id}/retry`)))).toEqual([409, 'file_purged'])
    await setEnterprise(owner.agent, ws, { privacy: { deleteWhenFinished: false } })
  })
})

describe('usage alerts', () => {
  it('email admins at 80% and 100% of a budget, once per threshold and cycle', async () => {
    const center = ok(await owner.agent.post(wsPath(ws, '/cost-centers'), { name: 'Legal' }), 'center').id
    ok(await owner.agent.post(wsPath(ws, '/budgets'), { costCenterId: center, unit: 'pages', amount: 10, cycle: { kind: 'month' }, action: 'warn' }), 'budget')
    const alerts = () => mail.filter((m) => m.subject.startsWith('Legal monthly budget'))
    ok(await pdfJob(bob.agent, ws, printer, 8, {}, { costCenter: center }), 'eight pages')
    await eventually(async () => expect(alerts().map((m) => m.subject)).toEqual(['Legal monthly budget: 80% used']))
    expect(alerts()[0].to).toEqual(['owner@example.com'])
    ok(await pdfJob(bob.agent, ws, printer, 1, {}, { costCenter: center }), 'nine pages')
    ok(await pdfJob(bob.agent, ws, printer, 3, {}, { costCenter: center }), 'twelve pages')
    await eventually(async () => expect(alerts().map((m) => m.subject)).toEqual(['Legal monthly budget: 80% used', 'Legal monthly budget: 100% used']))
    ok(await pdfJob(bob.agent, ws, printer, 1, {}, { costCenter: center }), 'more')
    await new Promise((r) => setTimeout(r, 100))
    expect(alerts()).toHaveLength(2)
  })

  it('email the person a personal limit counts, and admins separately', async () => {
    const limit = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO print_limits (id, workspace_id, name, scope, unit, amount, cycle, created_at, updated_at) VALUES (?, ?, 'Monthly pages', 'each-member', 'pages', 100, '{"kind":"month","startDay":1}', 0, 0)`,
    )
      .bind(limit, ws)
      .run()
    const draft = { workspaceId: ws, userId: bob.user.id, clientId: null } as JobDraft
    const meter = { kind: 'limit' as const, id: limit, name: 'Monthly pages', unit: 'pages' as const, used: 70, amount: 100, left: 30, start: 0, end: Date.UTC(2026, 11, 1), action: 'block' as const, over: false }
    await alertAfterJob(systemCtx(env, 'https://print.test', () => undefined), draft, [meter], { documentPages: 15, pages: 15, sheets: 15, colorPages: 0, costMicros: 0, estimated: true })
    const sent = mail.filter((m) => m.subject === 'Monthly pages: 80% used')
    expect(sent.map((m) => m.to)).toEqual([['bob@example.com'], ['owner@example.com']])
    expect(sent[0].text).toContain('Your count of Monthly pages')
    expect(sent[1].text).toContain(`${bob.user.name}’s count of Monthly pages`)
    const row = await env.DB.prepare('SELECT subject, threshold FROM usage_alerts WHERE limit_id = ?').bind(limit).first()
    expect(row).toEqual({ subject: `user:${bob.user.id}`, threshold: 80 })
  })

  it('alert on what a printer reported when it is more than the estimate', async () => {
    const live = await freshWorkspace(owner, 'Reported')
    await turnOnEnterprise(owner, live, { costCenters: { enabled: true }, alerts: { enabled: true } })
    const station = await connectPrinter(owner, 'usb:ent:reported', live)
    try {
      const center = ok(await owner.agent.post(wsPath(live, '/cost-centers'), { name: 'Studio' }), 'center').id
      ok(await owner.agent.post(wsPath(live, '/budgets'), { costCenterId: center, unit: 'pages', amount: 10, cycle: { kind: 'month' } }), 'budget')
      const id = ok(await job(owner.agent, live, station.printerId, { costCenter: center }), 'job').job.id
      await station.device.next('job')
      station.device.send({ type: 'job_status', jobId: id, status: 'completed', pages: 9 })
      await eventually(async () => expect(mail.map((m) => m.subject)).toContain('Studio monthly budget: 80% used'))
    } finally {
      station.device.close()
    }
  })

  it('alert on a limit once a printer reports more than the estimate', async () => {
    const live = await freshWorkspace(owner, 'Reported limits')
    await turnOnEnterprise(owner, live, { alerts: { enabled: true } })
    await switchExtension(owner, 'print-policies', live, true)
    const station = await connectPrinter(owner, 'usb:ent:limits', live)
    try {
      const limit = { name: 'Studio pages', scope: { type: 'each-member' }, unit: 'pages', amount: 10, cycle: { kind: 'month', startDay: 1 }, action: 'warn' }
      ok(await owner.agent.post(wsPath(live, '/policies/limits'), limit), 'limit')
      const id = ok(await job(owner.agent, live, station.printerId), 'job').job.id
      await station.device.next('job')
      expect(mail.map((m) => m.subject)).not.toContain('Studio pages: 80% used')
      station.device.send({ type: 'job_status', jobId: id, status: 'completed', pages: 9 })
      await eventually(async () => expect(mail.filter((m) => m.subject === 'Studio pages: 80% used').map((m) => m.to)).toEqual([['owner@example.com']]))
      const row = await env.DB.prepare('SELECT subject, threshold FROM usage_alerts WHERE workspace_id = ?').bind(live).first()
      expect(row).toEqual({ subject: `user:${owner.user.id}`, threshold: 80 })
    } finally {
      station.device.close()
    }
  })
})
