import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grant, ok, turnOnAccess, wsPath } from './helpers/access'
import { connectPrinter, eventually, type Station } from './helpers/device'
import { auditOf, code, giveEmail, job, outbox, quietPrinter, setControls, setEnterprise, turnOnEnterprise, type SentMail } from './helpers/enterprise'
import { call } from './helpers/http'
import { consistently, EventSocket, freshWorkspace, uploadJob } from './helpers/jobs'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let ws: string
let bob: Person
let printer: string
let mail: SentMail[]

beforeAll(async () => {
  owner = await setupOwner()
  ws = await freshWorkspace(owner, 'Approvals')
  bob = await addMember(owner, 'member', ws)
  await giveEmail(owner.user.id, 'owner@example.com')
  await giveEmail(bob.user.id, 'bob@example.com')
  await turnOnEnterprise(owner, ws, { approvals: { enabled: true }, release: { enabled: true } })
  printer = await quietPrinter(owner, ws)
  await setControls(owner.agent, ws, printer, { approval: true })
  mail = await outbox(owner)
})
afterAll(() => vi.restoreAllMocks())

const j = (id: string, action = '') => wsPath(ws, `/jobs/${id}${action}`)

describe('a printer that needs approval', () => {
  it('holds every job with its reason, tells approvers, and emails them', async () => {
    const events = await EventSocket.open(owner.agent, ws)
    try {
      const before = Date.now()
      const held = ok(await job(bob.agent, ws, printer), 'job').job
      expect(held).toMatchObject({ status: 'held', statusMessage: 'Waiting for approval', held: { kind: 'approval', reasons: [expect.stringMatching(/^Every job on .+ needs approval$/)] } })
      expect(held.held.until).toBeGreaterThanOrEqual(before + 24 * 3600_000)
      expect((await events.next('approval')).job.id).toBe(held.id)
      expect((await events.next('job', (e) => e.job.id === held.id)).job.status).toBe('held')
      const sent = await eventually(async () => {
        const found = mail.find((m) => m.subject.includes('needs approval'))
        if (!found) throw new Error('no approval email yet')
        return found
      })
      expect(sent.to).toEqual(['owner@example.com'])
      expect(sent.text).toContain(`/w/${ws}/jobs/approvals`)
      expect(await auditOf(ws, 'approval.request')).toContainEqual(expect.objectContaining({ target: held.id }))
    } finally {
      events.close()
    }
  })

  it('lists waiting jobs only to people who may approve them', async () => {
    const id = ok(await job(bob.agent, ws, printer), 'job').job.id
    expect(ok(await owner.agent.get(wsPath(ws, '/approvals')), 'approvals').map((x: { id: string }) => x.id)).toContain(id)
    expect(ok(await bob.agent.get(wsPath(ws, '/approvals')), 'approvals')).toEqual([])
    expect(ok(await bob.agent.get(wsPath(ws, '/jobs?status=held')), 'held').items.map((x: { id: string }) => x.id)).toContain(id)
  })

  it('approves: the job is queued with the approver’s note, once', async () => {
    const id = ok(await job(bob.agent, ws, printer), 'job').job.id
    expect(code(await bob.agent.post(j(id, '/approve')))).toEqual([403, 'forbidden'])
    const approved = ok(await owner.agent.post(j(id, '/approve'), { note: 'Fine this time' }), 'approve')
    expect(approved).toMatchObject({ status: 'queued', statusMessage: null })
    expect(approved).not.toHaveProperty('held')
    expect(approved.policy.notes).toContainEqual({ source: 'approval', id: null, name: 'Olive Owner', message: 'Approved: Fine this time' })
    expect(code(await owner.agent.post(j(id, '/approve')))).toEqual([409, 'job_not_held'])
    expect(code(await owner.agent.post(j(id, '/deny'), { reason: 'Late' }))).toEqual([409, 'job_not_held'])
    expect(await auditOf(ws, 'approval.approve')).toContainEqual(expect.objectContaining({ target: id }))
  })

  it('denies with a reason the sender sees', async () => {
    const id = ok(await job(bob.agent, ws, printer), 'job').job.id
    expect(code(await owner.agent.post(j(id, '/deny'), {}))).toEqual([400, 'invalid_request'])
    const denied = ok(await owner.agent.post(j(id, '/deny'), { reason: 'Use the copier' }), 'deny')
    expect(denied).toMatchObject({ status: 'canceled', statusMessage: 'Not approved: Use the copier' })
    expect(ok(await bob.agent.get(j(id)), 'job').statusMessage).toBe('Not approved: Use the copier')
    expect(await auditOf(ws, 'approval.deny')).toContainEqual(expect.objectContaining({ target: id }))
  })

  it('holds uploads once their file arrives, and checks retries again', async () => {
    const uploaded = await uploadJob(bob.agent, ws, printer)
    expect(uploaded).toMatchObject({ status: 'held', held: { kind: 'approval' } })
    ok(await owner.agent.post(j(uploaded.id, '/deny'), { reason: 'Wrong file' }), 'deny')
    expect(ok(await bob.agent.post(j(uploaded.id, '/retry')), 'retry')).toMatchObject({ status: 'held', attempts: 2 })
  })

  it('lets owners and admins approve their own jobs', async () => {
    const id = ok(await job(owner.agent, ws, printer), 'job').job.id
    expect(ok(await owner.agent.post(j(id, '/approve')), 'approve').status).toBe('queued')
  })

  it('holds for release next when the printer also asks for it', async () => {
    const both = await quietPrinter(owner, ws)
    await setControls(owner.agent, ws, both, { approval: true, secureRelease: true })
    const held = ok(await job(bob.agent, ws, both), 'job').job
    expect(held.held).toMatchObject({ kind: 'approval', release: true })
    const approved = ok(await owner.agent.post(j(held.id, '/approve')), 'approve')
    expect(approved).toMatchObject({ status: 'held', statusMessage: 'Waiting to be released at the printer', held: { kind: 'release' } })
  })

  it('never offers a held job to its device, nor its file, and offers it once approved', async () => {
    const station: Station = await connectPrinter(owner, 'usb:ent:live', ws)
    const download = (id: string) => call(`/api/client/jobs/${id}/file`, { headers: { Authorization: `Bearer ${station.token}` } })
    try {
      await setControls(owner.agent, ws, station.printerId, { approval: true })
      const id = ok(await job(bob.agent, ws, station.printerId), 'job').job.id
      await consistently(async () => expect(await station.device.next('job', 30).catch(() => null)).toBeNull())
      expect((await download(id)).status).toBe(404)
      ok(await owner.agent.post(j(id, '/approve')), 'approve')
      expect((await station.device.next('job')).job.id).toBe(id)
      const file = await download(id)
      expect(file.status).toBe(200)
      await file.arrayBuffer()
    } finally {
      station.device.close()
    }
  })
})

describe('approvers with Printer access', () => {
  it('include people with jobs.manage on the printer, for other people’s jobs only', async () => {
    const managed = await freshWorkspace(owner, 'Managed approvals')
    const carol = await addMember(owner, 'member', managed)
    const dan = await addMember(owner, 'member', managed)
    await turnOnAccess(owner, managed)
    await turnOnEnterprise(owner, managed, { approvals: { enabled: true } })
    const id = await quietPrinter(owner, managed)
    await setControls(owner.agent, managed, id, { approval: true })
    await grant(owner.agent, managed, id, { type: 'user', id: carol.user.id }, 'manager')
    const dans = ok(await job(dan.agent, managed, id), 'job').job.id
    const carols = ok(await job(carol.agent, managed, id), 'job').job.id
    expect(ok(await carol.agent.get(wsPath(managed, '/approvals')), 'list').map((x: { id: string }) => x.id)).toEqual([dans])
    expect(code(await carol.agent.post(wsPath(managed, `/jobs/${carols}/approve`)))).toEqual([403, 'forbidden'])
    expect(ok(await carol.agent.post(wsPath(managed, `/jobs/${dans}/approve`)), 'approve').status).toBe('queued')
    expect(code(await dan.agent.post(wsPath(managed, `/jobs/${carols}/approve`)))).toEqual([403, 'forbidden'])

    const fromWindow = ok(await job(carol.agent, managed, id), 'job').job.id
    await env.DB.prepare("UPDATE jobs SET user_id = NULL, source = 'device' WHERE id = ?").bind(fromWindow).run()
    expect(ok(await carol.agent.get(wsPath(managed, '/approvals')), 'list')).toEqual([])
    expect(code(await carol.agent.post(wsPath(managed, `/jobs/${fromWindow}/approve`)))).toEqual([403, 'forbidden'])
    expect(ok(await owner.agent.post(wsPath(managed, `/jobs/${fromWindow}/approve`)), 'owner approves').status).toBe('queued')
  })
})

describe('turning approvals off', () => {
  it('cancels the jobs waiting for it, and later jobs print', async () => {
    const id = ok(await job(bob.agent, ws, printer), 'job').job.id
    await setEnterprise(owner.agent, ws, { approvals: { enabled: false } })
    expect(ok(await bob.agent.get(j(id)), 'job')).toMatchObject({ status: 'canceled', statusMessage: 'Approvals were turned off' })
    expect(await auditOf(ws, 'job.cancel')).toContainEqual(expect.objectContaining({ target: id }))
    expect(ok(await job(bob.agent, ws, printer), 'job').job.status).toBe('queued')
    await setEnterprise(owner.agent, ws, { approvals: { enabled: true } })
  })
})
