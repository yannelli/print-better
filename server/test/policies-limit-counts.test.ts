import { env } from 'cloudflare:workers'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Cycle } from '../shared/usage'
import { cycleAt } from '../worker/extensions/usage/cycles'
import { ok, wsPath } from './helpers/access'
import { eventually } from './helpers/device'
import { readReply } from './helpers/http'
import { jobsPath } from './helpers/jobs'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'
import { entriesOf, limitsPath, office, type Office, pdfJob, pdfOf, turnOnPolicies } from './helpers/usage'

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
})
afterAll(() => p.device.close())
afterEach(async () => {
  for (const limit of ok(await owner.agent.get(limitsPath(ws)), 'limits')) await owner.agent.del(limitsPath(ws, `/${limit.id}`))
  await env.DB.prepare('DELETE FROM usage_entries WHERE workspace_id = ?').bind(ws).run()
  ok(await owner.agent.put(wsPath(ws, '/prices'), { timeZone: 'UTC', default: { bwPageMicros: 0, colorPageMicros: 0, duplexSheetDiscountMicros: 0 } }), 'reset prices')
})

const MONTH: Cycle = { kind: 'month', startDay: 1 }
const limit = async (body: object) =>
  ok(await owner.agent.post(limitsPath(ws), { name: 'Monthly pages', unit: 'pages', amount: 50, cycle: MONTH, scope: { type: 'each-member' }, ...body }), 'create limit')
const mine = async (agent = member.agent) => ok(await agent.get(wsPath(ws, '/usage/me')), 'usage/me').limits
const resetDay = (cycle: Cycle = MONTH, zone = 'UTC') =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: zone }).format(cycleAt(cycle, zone, Date.now()).end)

describe('a monthly page limit for each member', () => {
  it('counts each member’s pages, refuses the job that would go over, and says what is left and when it starts over', async () => {
    const monthly = await limit({})
    expect(ok(await pdfJob(member.agent, ws, p.color, 30), 'first').job.usage.pages).toBe(30)
    expect(await mine()).toEqual([{ id: monthly.id, name: 'Monthly pages', scope: { type: 'each-member' }, action: 'block', unit: 'pages', used: 30, amount: 50, left: 20, ...cycleAt(MONTH, 'UTC', Date.now()) }])
    const refused = await pdfJob(member.agent, ws, p.color, 30)
    expect(refused).toMatchObject({
      status: 403,
      body: { error: { code: 'policy_blocked', message: `Over the limit Monthly pages: this job needs 30 pages and 20 pages are left this month. It starts over on ${resetDay()}.` } },
    })
    expect(ok(await pdfJob(owner.agent, ws, p.color, 30), 'someone else').job.usage.pages).toBe(30)
    expect((await pdfJob(member.agent, ws, p.color, 20)).status).toBe(200)
    expect((await pdfJob(member.agent, ws, p.color, 1)).body.error.message).toContain('this job needs 1 page and 0 pages are left this month')
    expect((await mine())[0]).toMatchObject({ used: 50, left: 0 })
  })

  it('warns instead when set to, noting what was left', async () => {
    await limit({ action: 'warn', amount: 10 })
    expect((await pdfJob(member.agent, ws, p.color, 8)).body.job.policy).toBeUndefined()
    const over = ok(await pdfJob(member.agent, ws, p.color, 5), 'over').job
    expect(over.status).toBe('queued')
    expect(over.policy.notes).toEqual([{ source: 'limit', id: expect.any(String), name: 'Monthly pages', message: 'Went over the limit, with 2 of 10 pages left this month' }])
  })

  it('blocks when set to require approval while Enterprise controls is off', async () => {
    await limit({ action: 'approval', amount: 5 })
    expect((await pdfJob(member.agent, ws, p.color, 6)).body.error).toMatchObject({ code: 'policy_blocked', message: expect.stringContaining('Over the limit Monthly pages') })
  })

  it('leaves owners and admins out when it says so, and does nothing while turned off', async () => {
    const monthly = await limit({ amount: 5, exemptAdmins: true })
    expect((await pdfJob(owner.agent, ws, p.color, 6)).status).toBe(200)
    expect(await mine(owner.agent)).toEqual([])
    expect((await pdfJob(member.agent, ws, p.color, 6)).status).toBe(403)
    ok(await owner.agent.patch(limitsPath(ws, `/${monthly.id}`), { enabled: false }), 'turn off')
    expect((await pdfJob(member.agent, ws, p.color, 6)).status).toBe(200)
    expect(await mine()).toEqual([])
  })

  it('lets a member print more after an extra allowance, for this cycle only', async () => {
    const monthly = await limit({ amount: 10 })
    await pdfJob(member.agent, ws, p.color, 10)
    expect((await pdfJob(member.agent, ws, p.color, 5)).status).toBe(403)
    ok(await owner.agent.post(limitsPath(ws, `/${monthly.id}/adjustments`), { amount: 5, subject: { type: 'user', id: member.user.id } }), 'extra')
    expect((await mine())[0]).toMatchObject({ used: 10, amount: 15, left: 5 })
    expect((await pdfJob(member.agent, ws, p.color, 5)).status).toBe(200)
    await env.DB.prepare('UPDATE limit_adjustments SET cycle_start = cycle_start - 1 WHERE limit_id = ?').bind(monthly.id).run()
    expect((await mine())[0]).toMatchObject({ amount: 10, left: -5 })
  })

  it('keeps an extra allowance when the time zone changes', async () => {
    const yearly = await limit({ name: 'Yearly pages', amount: 10, cycle: { kind: 'year', startMonth: 1 } })
    ok(await owner.agent.post(limitsPath(ws, `/${yearly.id}/adjustments`), { amount: 5, subject: { type: 'user', id: member.user.id } }), 'extra')
    // An hour east of UTC, so this year now starts an hour before the allowance's cycle did.
    ok(await owner.agent.put(wsPath(ws, '/prices'), { timeZone: 'Africa/Lagos' }), 'zone')
    expect((await mine())[0]).toMatchObject({ amount: 15 })
    expect(ok(await owner.agent.get(limitsPath(ws, `/${yearly.id}/adjustments`)), 'adjustments')).toHaveLength(1)
  })

  it('lets jobs sent at the same moment through only as far as a blocking limit has room', async () => {
    await limit({ amount: 10, cycle: { kind: 'day' } })
    const replies = await Promise.all(Array.from({ length: 8 }, () => pdfJob(member.agent, ws, p.mono, 10)))
    expect(replies.map((r) => r.status).sort()).toEqual([200, 403, 403, 403, 403, 403, 403, 403])
    for (const refused of replies.filter((r) => r.status === 403)) {
      expect(refused.body.error).toMatchObject({ code: 'policy_blocked', message: expect.stringContaining('this job needs 10 pages and 0 pages are left today') })
    }
    expect((await mine())[0]).toMatchObject({ used: 10, left: 0 })
  })

  it('refuses the retry or upload that loses the race the same way', async () => {
    await limit({ amount: 10, cycle: { kind: 'day' } })
    const cancel = async (id: string) => {
      ok(await member.agent.post(`${jobsPath(ws)}/${id}/cancel`), 'cancel')
      await eventually(async () => expect((await entriesOf(id)).at(-1)).toMatchObject({ pages: 0, estimated: 0 }))
    }
    const canceled = []
    for (let i = 0; i < 2; i++) {
      canceled.push(ok(await pdfJob(member.agent, ws, p.mono, 10), 'job').job.id)
      await cancel(canceled[i])
    }
    const retries = await Promise.all(canceled.map((id) => member.agent.post(`${jobsPath(ws)}/${id}/retry`)))
    expect(retries.map((r) => r.status).sort()).toEqual([200, 403])
    await cancel(retries.find((r) => r.status === 200)!.body.id)

    const bytes = pdfOf(10)
    const slot = async () => ok(await member.agent.post(jobsPath(ws), { printerId: p.mono, upload: { fileName: 'doc.pdf', contentType: 'application/pdf', size: bytes.length } }), 'slot')
    const put = async (s: { uploadUrl: string }) =>
      readReply(await member.agent.fetch(new URL(s.uploadUrl).pathname, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/pdf' } }))
    const uploads = await Promise.all((await Promise.all([slot(), slot()])).map(put))
    expect(uploads.map((r) => r.status).sort()).toEqual([200, 403])
    expect(uploads.find((r) => r.status === 403)!.body.error.message).toContain('this job needs 10 pages and 0 pages are left today')
    expect((await mine())[0]).toMatchObject({ used: 10 })
  })
})

describe('units', () => {
  it('count sheets, so two-sided jobs use half as many', async () => {
    await limit({ unit: 'sheets', amount: 10 })
    expect(ok(await pdfJob(member.agent, ws, p.color, 20, { sides: 'two-sided-long-edge' }), 'two-sided').job.usage.sheets).toBe(10)
    expect((await pdfJob(member.agent, ws, p.color, 1)).body.error.message).toContain('this job needs 1 sheet and 0 sheets are left')
  })

  it('count jobs, one each whatever their size', async () => {
    await limit({ unit: 'jobs', amount: 2, cycle: { kind: 'day' } })
    await pdfJob(member.agent, ws, p.color, 40)
    await pdfJob(member.agent, ws, p.mono, 1)
    expect((await pdfJob(member.agent, ws, p.mono, 1)).body.error.message).toContain('this job needs 1 job and 0 jobs are left today')
  })

  it('count cost from the workspace prices', async () => {
    ok(await owner.agent.put(wsPath(ws, '/prices'), { default: { bwPageMicros: 50_000, colorPageMicros: 50_000, duplexSheetDiscountMicros: 0 } }), 'prices')
    await limit({ unit: 'cost', amount: 1_000_000, cycle: { kind: 'week', firstDay: 1 } })
    expect(ok(await pdfJob(member.agent, ws, p.mono, 10), 'cheap').job.usage.costMicros).toBe(500_000)
    expect((await pdfJob(member.agent, ws, p.mono, 11)).body.error.message).toContain('this job needs $0.55 and $0.50 is left this week')
  })
})

describe('cycles', () => {
  it('start at local midnight in the workspace time zone', async () => {
    ok(await owner.agent.put(wsPath(ws, '/prices'), { timeZone: 'America/Chicago' }), 'zone')
    const cycle: Cycle = { kind: 'month', startDay: 20 }
    await limit({ cycle })
    const job = ok(await pdfJob(member.agent, ws, p.color, 7), 'job').job
    const { start, end } = cycleAt(cycle, 'America/Chicago', Date.now())
    expect((await mine())[0]).toMatchObject({ used: 7, start, end })
    await env.DB.prepare('UPDATE usage_entries SET at = ? WHERE job_id = ?').bind(start - 1, job.id).run()
    expect((await mine())[0]).toMatchObject({ used: 0 })
    await env.DB.prepare('UPDATE usage_entries SET at = ? WHERE job_id = ?').bind(start, job.id).run()
    expect((await mine())[0]).toMatchObject({ used: 7 })
    const refused = await pdfJob(member.agent, ws, p.color, 44)
    expect(refused.body.error.message).toContain(`It starts over on ${resetDay(cycle, 'America/Chicago')}.`)
  })

  it('show the previous cycle to admins', async () => {
    const monthly = await limit({ scope: { type: 'workspace' } })
    const job = ok(await pdfJob(member.agent, ws, p.color, 9), 'job').job
    const before = cycleAt(MONTH, 'UTC', Date.now()).start - 1
    await env.DB.prepare('UPDATE usage_entries SET at = ? WHERE job_id = ?').bind(before, job.id).run()
    const usage = async (cycle: string) => ok(await owner.agent.get(wsPath(ws, `/usage?cycle=${cycle}`)), cycle)
    expect((await usage('previous'))[0]).toMatchObject({ id: monthly.id, usage: [{ subject: null, used: 9, amount: 50, end: before + 1 }] })
    expect((await usage('current'))[0].usage[0]).toMatchObject({ used: 0, start: before + 1 })
    expect((await owner.agent.get(wsPath(ws, '/usage?cycle=last'))).status).toBe(400)
  })
})
