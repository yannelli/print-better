import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCron } from '../worker/cron'
import { ok, wsPath } from './helpers/access'
import { eventually } from './helpers/device'
import { EventSocket, freshWorkspace, jobsPath } from './helpers/jobs'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'
import { entriesOf, type EntryRow, limitsPath, office, type Office, pdfJob, switchExtension, turnOnPolicies } from './helpers/usage'

const PRICES = { bwPageMicros: 50_000, colorPageMicros: 200_000, duplexSheetDiscountMicros: 10_000 }

let owner: Owner
let member: Person
let ws: string
let p: Office

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  member = await addMember(owner)
  p = await office(owner, ws)
  await turnOnPolicies(owner, ws)
  ok(await owner.agent.put(wsPath(ws, '/prices'), { default: PRICES }), 'prices')
})
afterAll(() => p.device.close())

const report = (jobId: string, status: string, extra: Record<string, unknown> = {}) => p.device.send({ type: 'job_status', jobId, status, ...extra })
const job = async (printerId: string, pages: number, options = {}, who = member) => ok(await pdfJob(who.agent, ws, printerId, pages, options), 'job').job
const jobOf = async (id: string) => ok(await owner.agent.get(`${jobsPath(ws)}/${id}`), 'job')
const settled = (id: string): Promise<EntryRow> =>
  eventually(async () => {
    const [entry] = await entriesOf(id)
    expect(entry.estimated).toBe(0)
    return entry
  })

describe('settling usage when a job ends', () => {
  it('counts what the device says printed, with the cost of those pages, and tells open pages', async () => {
    const events = await EventSocket.open(member.agent, ws)
    try {
      const printed = await job(p.color, 10, { sides: 'two-sided-long-edge' })
      expect(printed.usage).toEqual({ documentPages: 10, pages: 10, sheets: 5, colorPages: 10, costMicros: 1_950_000, estimated: true })
      report(printed.id, 'completed', { pages: 7 })
      // 7 color pages at 0.20, less 0.01 for each of the 3 sheets printed on both sides.
      expect(await settled(printed.id)).toMatchObject({ jobs: 1, pages: 7, sheets: 4, color_pages: 7, cost_micros: 1_370_000, settled_at: expect.any(Number) })
      expect((await jobOf(printed.id)).usage).toEqual({ documentPages: 10, pages: 7, sheets: 4, colorPages: 7, costMicros: 1_370_000, estimated: false })
      await events.next('usage')
    } finally {
      events.close()
    }
  })

  it('keeps the estimate when the device doesn’t say how many pages printed', async () => {
    const printed = await job(p.mono, 4)
    report(printed.id, 'completed')
    expect(await settled(printed.id)).toMatchObject({ jobs: 1, pages: 4, sheets: 4, cost_micros: 200_000 })
  })

  it('counts nothing for failed and canceled jobs, which frees what a limit held for them', async () => {
    const fresh = await addMember(owner)
    const limit = ok(await owner.agent.post(limitsPath(ws), { name: 'Pages', unit: 'pages', amount: 10, cycle: { kind: 'day' }, scope: { type: 'member', id: fresh.user.id } }), 'limit')
    try {
      const failed = await job(p.mono, 10, {}, fresh)
      expect((await pdfJob(fresh.agent, ws, p.mono, 1)).status).toBe(403)
      report(failed.id, 'failed', { message: 'Paper jam' })
      expect(await settled(failed.id)).toMatchObject({ jobs: 0, pages: 0, sheets: 0, cost_micros: 0 })
      expect((await jobOf(failed.id)).usage).toMatchObject({ pages: 0, estimated: false })
      const canceled = await job(p.mono, 10, {}, fresh)
      ok(await fresh.agent.post(`${jobsPath(ws)}/${canceled.id}/cancel`), 'cancel')
      expect(await settled(canceled.id)).toMatchObject({ pages: 0 })
      expect((await pdfJob(fresh.agent, ws, p.mono, 10)).status).toBe(200)
    } finally {
      await owner.agent.del(limitsPath(ws, `/${limit.id}`))
    }
  })

  it('keeps the estimate when a completed job reports 0 pages, as printers that don’t count pages do', async () => {
    const printed = await job(p.mono, 4)
    report(printed.id, 'completed', { pages: 0 })
    expect(await settled(printed.id)).toMatchObject({ jobs: 1, pages: 4, sheets: 4, cost_micros: 200_000 })
  })

  it('starts a new estimate for a retry, leaving the failed attempt at zero', async () => {
    const first = await job(p.mono, 3)
    report(first.id, 'failed')
    await settled(first.id)
    const retried = ok(await member.agent.post(`${jobsPath(ws)}/${first.id}/retry`), 'retry')
    expect(retried.usage).toMatchObject({ pages: 3, estimated: true })
    report(first.id, 'completed', { pages: 3, attempt: 2 })
    await eventually(async () => expect((await entriesOf(first.id)).map((e) => [e.attempt, e.pages, e.estimated])).toEqual([[1, 0, 0], [2, 3, 0]]))
  })

  it('still settles usage recorded while the extension was on after it is turned off', async () => {
    const printed = await job(p.mono, 5)
    await switchExtension(owner, 'print-policies', ws, false)
    try {
      report(printed.id, 'completed', { pages: 2 })
      expect(await settled(printed.id)).toMatchObject({ pages: 2, cost_micros: 100_000 })
      expect(ok(await member.agent.get(`${jobsPath(ws)}/${printed.id}`), 'job').usage).toMatchObject({ pages: 2, estimated: false })
    } finally {
      await turnOnPolicies(owner, ws)
    }
  })
})

describe('the settling sweep', () => {
  it('settles attempts that ended without settling, zeroes old attempts, and keeps the estimate of deleted jobs', async () => {
    const ended = await job(p.mono, 6)
    const retried = await job(p.mono, 2)
    const deleted = await job(p.mono, 8)
    const db = env.DB
    await db.batch([
      db.prepare("UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?").bind(Date.now(), ended.id),
      db.prepare('UPDATE jobs SET attempts = 2 WHERE id = ?').bind(retried.id),
      db.prepare('DELETE FROM jobs WHERE id = ?').bind(deleted.id),
    ])
    await runCron(env)
    expect(await entriesOf(ended.id)).toMatchObject([{ jobs: 1, pages: 6, estimated: 0 }])
    expect(await entriesOf(retried.id)).toMatchObject([{ jobs: 0, pages: 0, estimated: 0 }])
    expect(await entriesOf(deleted.id)).toMatchObject([{ jobs: 1, pages: 8, estimated: 0 }])
    expect((await jobOf(ended.id)).usage).toMatchObject({ pages: 6, estimated: false })
  })

  it('settles the other workspaces when one of them fails', async () => {
    const failing = await job(p.mono, 6)
    const other = await freshWorkspace(owner)
    await turnOnPolicies(owner, other)
    const q = await office(owner, other)
    try {
      const fine = ok(await pdfJob(owner.agent, other, q.mono, 2), 'job').job
      const db = env.DB
      await db.batch([failing.id, fine.id].map((id) => db.prepare("UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?").bind(Date.now(), id)))
      await db.prepare(`CREATE TRIGGER settle_fails BEFORE UPDATE ON usage_entries WHEN OLD.job_id = '${failing.id}' BEGIN SELECT RAISE(ABORT, 'settle failed'); END`).run()
      try {
        await runCron(env)
      } finally {
        await db.prepare('DROP TRIGGER settle_fails').run()
      }
      expect(await entriesOf(fine.id)).toMatchObject([{ pages: 2, estimated: 0 }])
      expect(await entriesOf(failing.id)).toMatchObject([{ estimated: 1 }])
      await runCron(env)
      expect(await entriesOf(failing.id)).toMatchObject([{ pages: 6, estimated: 0 }])
    } finally {
      q.device.close()
    }
  })
})
