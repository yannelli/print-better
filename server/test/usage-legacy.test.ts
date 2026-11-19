import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ok, wsPath } from './helpers/access'
import { connectPrinter, eventually, type Station } from './helpers/device'
import { call, nextIp, readReply, type Body, type Reply } from './helpers/http'
import { jobsPath } from './helpers/jobs'
import { deliver, emailWorld, INBOUND_DOMAIN, setUserEmail } from './helpers/mail'
import { callTool } from './helpers/mcp'
import { entriesIn, limitsPath, pdfJob, pdfOf, rulesPath, switchExtension, turnOnPolicies } from './helpers/usage'
import { addMember, createPat, enrollDevice, type Owner, type Person } from './helpers/world'

const SENDER = 'member@home.example'
const USAGE_TABLES = /usage_entries|usage_settings|printer_prices|print_rules|print_limits|limit_adjustments/
const CHECKED_COLUMNS = /\b(policy|usage|held|cost_center_id)\s*=|INSERT INTO jobs \([^)]*\b(policy|usage|held|cost_center_id)\b/

let owner: Owner
let member: Person
let s: Station
let desk: { clientId: string; token: string }
let ws: string
let token: string

beforeAll(async () => {
  owner = (await emailWorld()).owner
  ws = owner.workspaceId
  member = await addMember(owner)
  await setUserEmail(member.user.id, SENDER)
  s = await connectPrinter(owner, 'usb:legacy-usage')
  ok(await owner.agent.patch(wsPath(ws, `/printers/${s.printerId}`), { settings: { email: { enabled: true, alias: 'Desk' } } }), 'printer email')
  desk = await enrollDevice(owner, ws)
  token = await createPat(member, ws)
})
afterAll(() => s.device.close())

/** Every statement the Worker prepares while `act` runs, with whatever `act` returns. */
async function traced<T>(act: () => Promise<T>): Promise<{ sql: string[]; result: T }> {
  const sql: string[] = []
  const prepare = env.DB.prepare.bind(env.DB)
  const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((query: string) => {
    sql.push(query.replace(/\s+/g, ' '))
    return prepare(query)
  })
  try {
    return { sql, result: await act() }
  } finally {
    spy.mockRestore()
  }
}

/** No usage table, no new job column, and at most the one memoized look at which extensions are on. */
function expectLegacySql(sql: string[]) {
  expect(sql.filter((q) => USAGE_TABLES.test(q))).toEqual([])
  expect(sql.filter((q) => CHECKED_COLUMNS.test(q))).toEqual([])
  expect(sql.filter((q) => q.includes('workspace_extensions')).length).toBeLessThanOrEqual(1)
}

function expectLegacyJob(job: Body) {
  for (const key of ['policy', 'usage', 'held', 'costCenterId']) expect(job, key).not.toHaveProperty(key)
}

const deviceCall = async (method: string, path: string, body: BodyInit, type = 'application/json') =>
  readReply(await call(path, { method, body, headers: { Authorization: `Bearer ${desk.token}`, 'Content-Type': type, 'CF-Connecting-IP': nextIp() } }))

/** Each way a job is made, one request at a time, returning the job. */
const PATHS: [string, () => Promise<Reply>][] = [
  ['text', () => member.agent.post(jobsPath(ws), { printerId: s.printerId, text: 'Hello' })],
  ['base64', () => pdfJob(member.agent, ws, s.printerId, 3)],
  ['test page', () => owner.agent.post(wsPath(ws, `/printers/${s.printerId}/test-page`))],
]

async function everyPath(): Promise<Body[]> {
  const jobs: Body[] = []
  for (const [name, send] of PATHS) {
    const { sql, result } = await traced(send)
    expect(result.status, name).toBeLessThan(300)
    expectLegacySql(sql)
    jobs.push(result.body.job ?? result.body)
  }
  const printed = await traced(() => callTool(token, 'print', { printerId: s.printerId, text: 'From an assistant' }))
  expect(printed.result.isError).toBe(false)
  expectLegacySql(printed.sql)
  jobs.push(printed.result.data.job)

  const bytes = pdfOf(2)
  const slot = await traced(() => member.agent.post(jobsPath(ws), { printerId: s.printerId, upload: { fileName: 'a.pdf', contentType: 'application/pdf', size: bytes.length } }))
  const put = await traced(async () => readReply(await member.agent.fetch(new URL(slot.result.body.uploadUrl).pathname, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/pdf' } })))
  const deviceSlot = await traced(() => deviceCall('POST', '/api/client/jobs', JSON.stringify({ printerId: s.printerId, contentType: 'application/pdf', size: bytes.length })))
  const devicePut = await traced(() => deviceCall('PUT', new URL(deviceSlot.result.body.uploadUrl).pathname, bytes, 'application/pdf'))
  for (const step of [slot, put, deviceSlot, devicePut]) {
    expect(step.result.status).toBeLessThan(300)
    expectLegacySql(step.sql)
  }
  jobs.push(put.result.body.job, devicePut.result.body.job)

  const mailed = await traced(() => deliver({ from: SENDER, to: `desk@${INBOUND_DOMAIN}`, parts: [{ contentType: 'application/pdf', fileName: 'm.pdf', data: bytes }] }))
  expect(mailed.result).toBeNull()
  expectLegacySql(mailed.sql)
  return jobs
}

async function rowsAreLegacy(ids: string[]) {
  const rows = await env.DB.prepare('SELECT status_message, policy, held, usage, cost_center_id FROM jobs WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all()
  expect(rows.results).toEqual(ids.map(() => ({ status_message: null, policy: null, held: null, usage: null, cost_center_id: null })))
}

describe('with both usage extensions off', () => {
  it('makes jobs on every path exactly as before: no usage, no new fields, no ledger, no extra queries', async () => {
    const jobs = await everyPath()
    for (const job of jobs) expectLegacyJob(job)
    await rowsAreLegacy(jobs.map((j) => j.id))
    expect(await entriesIn(ws)).toEqual([])
  })

  it('cancels, retries and finishes jobs as before', async () => {
    const job = ok(await member.agent.post(jobsPath(ws), { printerId: s.printerId, text: 'Again' }), 'job').job
    const canceled = await traced(() => member.agent.post(`${jobsPath(ws)}/${job.id}/cancel`))
    const retried = await traced(() => member.agent.post(`${jobsPath(ws)}/${job.id}/retry`))
    for (const step of [canceled, retried]) {
      expectLegacySql(step.sql)
      expectLegacyJob(step.result.body)
    }
    const finished = await traced(async () => {
      s.device.send({ type: 'job_status', jobId: job.id, status: 'completed', pages: 1, attempt: 2 })
      await eventually(async () => expect(ok(await member.agent.get(`${jobsPath(ws)}/${job.id}`), 'job').status).toBe('completed'))
    })
    expect(finished.sql.filter((q) => USAGE_TABLES.test(q) || CHECKED_COLUMNS.test(q))).toEqual([])
    await rowsAreLegacy([job.id])
  })

  it('stays the same when the extensions are available but off in this workspace', async () => {
    ok(await owner.agent.patch('/api/admin/extensions/print-policies', { available: true }), 'available')
    const jobs = await everyPath()
    for (const job of jobs) expectLegacyJob(job)
    expect(await entriesIn(ws)).toEqual([])
  })
})

describe('turning print rules and limits off and on', () => {
  it('keeps rules, limits and usage, and stops checking jobs while off', async () => {
    await turnOnPolicies(owner, ws)
    const { sql, result } = await traced(() => pdfJob(member.agent, ws, s.printerId, 4))
    // The same trace sees the checked path, so the checks above can fail.
    expect([sql.some((q) => USAGE_TABLES.test(q)), sql.some((q) => CHECKED_COLUMNS.test(q))]).toEqual([true, true])
    const counted = ok(result, 'counted').job
    expect(counted.usage).toMatchObject({ pages: 4, estimated: true })
    const rule = ok(await owner.agent.post(rulesPath(ws), { name: 'No big jobs', conditions: { pages: { min: 10 } }, actions: [{ type: 'block', message: 'Too big.' }] }), 'rule')
    ok(await owner.agent.post(limitsPath(ws), { name: 'Pages', unit: 'pages', amount: 6, cycle: { kind: 'day' }, scope: { type: 'each-member' } }), 'limit')
    expect((await pdfJob(member.agent, ws, s.printerId, 12)).status).toBe(403)

    await switchExtension(owner, 'print-policies', ws, false)
    expect((await owner.agent.get(rulesPath(ws))).status).toBe(404)
    const free = ok(await pdfJob(member.agent, ws, s.printerId, 12), 'prints while off').job
    expectLegacyJob(free)
    expect(ok(await member.agent.get(`${jobsPath(ws)}/${counted.id}`), 'kept').usage).toMatchObject({ pages: 4 })

    await turnOnPolicies(owner, ws)
    expect(ok(await owner.agent.get(rulesPath(ws)), 'rules')).toEqual([rule])
    expect(ok(await owner.agent.get(limitsPath(ws)), 'limits')[0].usage.find((u: Body) => u.subject.id === member.user.id)).toMatchObject({ used: 4 })
    expect((await pdfJob(member.agent, ws, s.printerId, 3)).body.error.message).toContain('this job needs 3 pages and 2 pages are left today')
  })
})
