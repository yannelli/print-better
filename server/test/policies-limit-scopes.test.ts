import { env } from 'cloudflare:workers'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { newGroup, ok, setEveryone, wsPath } from './helpers/access'
import { call, nextIp, readReply, type Reply } from './helpers/http'
import { jobsPath } from './helpers/jobs'
import { addMember, enrollDevice, setupOwner, type Owner, type Person } from './helpers/world'
import { limitsPath, office, type Office, pdfJob, pdfOf, switchExtension, turnOnPolicies } from './helpers/usage'

let owner: Owner
let member: Person
let other: Person
let outsider: Person
let desk: { clientId: string; token: string }
let ws: string
let p: Office
let lab: string

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  ;[member, other, outsider] = [await addMember(owner), await addMember(owner), await addMember(owner)]
  p = await office(owner, ws)
  desk = await enrollDevice(owner, ws)
  await switchExtension(owner, 'printer-access', ws, true)
  const people = [member, other].map((m) => ({ type: 'user' as const, id: m.user.id }))
  lab = await newGroup(owner.agent, ws, 'Lab', [...people, { type: 'client', id: desk.clientId }])
  await turnOnPolicies(owner, ws)
})
afterAll(() => p.device.close())
afterEach(async () => {
  for (const limit of ok(await owner.agent.get(limitsPath(ws)), 'limits')) await owner.agent.del(limitsPath(ws, `/${limit.id}`))
  await env.DB.prepare('DELETE FROM usage_entries WHERE workspace_id = ?').bind(ws).run()
})

const limit = async (scope: object, amount = 10) =>
  ok(await owner.agent.post(limitsPath(ws), { name: 'Pages', unit: 'pages', amount, cycle: { kind: 'month', startDay: 1 }, scope }), 'create limit')
const status = async (reply: Promise<Reply>) => (await reply).status

const deviceCall = async (token: string, method: string, path: string, body: BodyInit, type = 'application/json') =>
  readReply(await call(path, { method, body, headers: { Authorization: `Bearer ${token}`, 'Content-Type': type, 'CF-Connecting-IP': nextIp() } }))

/** A computer's print window: an upload slot, then the file. */
async function deviceJob(token: string, printerId: string, pages: number): Promise<Reply> {
  const bytes = pdfOf(pages)
  const slot = await deviceCall(token, 'POST', '/api/client/jobs', JSON.stringify({ printerId, contentType: 'application/pdf', size: bytes.length, fileName: 'scan.pdf' }))
  if (slot.status !== 201) return slot
  return deviceCall(token, 'PUT', new URL(slot.body.uploadUrl).pathname, bytes, 'application/pdf')
}

const usageOf = async (id: string) => ok(await owner.agent.get(limitsPath(ws)), 'limits').find((l: { id: string }) => l.id === id).usage

describe('limit scopes', () => {
  it('a member: only that member’s jobs count', async () => {
    await limit({ type: 'member', id: member.user.id })
    await pdfJob(member.agent, ws, p.color, 8)
    expect(await status(pdfJob(other.agent, ws, p.color, 8))).toBe(200)
    expect(await status(pdfJob(member.agent, ws, p.color, 3))).toBe(403)
    expect(await status(deviceJob(desk.token, p.color, 3))).toBe(200)
  })

  it('a group: its members and devices share one count', async () => {
    const shared = await limit({ type: 'group', id: lab })
    await pdfJob(member.agent, ws, p.color, 6)
    expect(await status(deviceJob(desk.token, p.color, 3))).toBe(200)
    expect(await status(pdfJob(other.agent, ws, p.color, 2))).toBe(403)
    expect(await status(pdfJob(outsider.agent, ws, p.color, 20))).toBe(200)
    expect(await usageOf(shared.id)).toEqual([expect.objectContaining({ subject: null, used: 9, left: 1 })])
  })

  it('each in a group: every member and device has its own count', async () => {
    const each = await limit({ type: 'group-each', id: lab })
    await pdfJob(member.agent, ws, p.color, 10)
    expect(await status(pdfJob(member.agent, ws, p.color, 1))).toBe(403)
    expect(await status(pdfJob(other.agent, ws, p.color, 10))).toBe(200)
    expect(await status(deviceJob(desk.token, p.color, 10))).toBe(200)
    expect(await status(pdfJob(outsider.agent, ws, p.color, 20))).toBe(200)
    const counts = (await usageOf(each.id)).map((u: { subject: { id: string }; used: number }) => [u.subject.id, u.used])
    expect(counts).toEqual(expect.arrayContaining([[member.user.id, 10], [other.user.id, 10], [desk.clientId, 10]]))
    expect(counts).toHaveLength(3)
  })

  it('groups count only while Printer access is on, since groups belong to it', async () => {
    await limit({ type: 'group', id: lab }, 1)
    try {
      await switchExtension(owner, 'printer-access', ws, false)
      expect(await status(pdfJob(member.agent, ws, p.color, 5))).toBe(200)
    } finally {
      await switchExtension(owner, 'printer-access', ws, true)
    }
    expect(await status(pdfJob(member.agent, ws, p.color, 1))).toBe(403)
  })

  it('each device, or one device: jobs from members don’t count', async () => {
    const each = await limit({ type: 'each-device' }, 5)
    expect(await status(deviceJob(desk.token, p.color, 5))).toBe(200)
    expect(await status(pdfJob(member.agent, ws, p.color, 20))).toBe(200)
    expect(await status(deviceJob(p.token, p.color, 5))).toBe(200)
    expect(await status(deviceJob(desk.token, p.color, 1))).toBe(403)
    await owner.agent.del(limitsPath(ws, `/${each.id}`))
    await limit({ type: 'device', id: p.clientId }, 6)
    expect(await status(deviceJob(desk.token, p.color, 5))).toBe(200)
    expect(await status(deviceJob(p.token, p.color, 2))).toBe(403)
  })

  it('a printer: every job sent to it, from anyone', async () => {
    await limit({ type: 'printer', id: p.mono })
    await pdfJob(member.agent, ws, p.mono, 4)
    expect(await status(deviceJob(desk.token, p.mono, 4))).toBe(200)
    expect(await status(pdfJob(other.agent, ws, p.color, 30))).toBe(200)
    expect(await status(pdfJob(owner.agent, ws, p.mono, 3))).toBe(403)
  })

  it('the workspace: every job', async () => {
    await limit({ type: 'workspace' })
    await pdfJob(member.agent, ws, p.color, 5)
    await deviceJob(desk.token, p.mono, 5)
    expect(await status(pdfJob(owner.agent, ws, p.color, 1))).toBe(403)
  })
})

describe('what members see', () => {
  it('lists the limits that count their jobs, printer limits only for printers they can see', async () => {
    const own = await limit({ type: 'each-member' })
    const color = await limit({ type: 'printer', id: p.color })
    const mono = await limit({ type: 'printer', id: p.mono })
    await limit({ type: 'member', id: other.user.id })
    await limit({ type: 'each-device' })
    await setEveryone(owner.agent, ws, p.mono, 'none')
    try {
      const listed = ok(await member.agent.get(wsPath(ws, '/usage/me')), 'mine').limits.map((l: { id: string }) => l.id)
      expect(listed.sort()).toEqual([own.id, color.id].sort())
      expect(ok(await owner.agent.get(wsPath(ws, '/usage/me')), 'owner').limits.map((l: { id: string }) => l.id)).toContain(mono.id)
    } finally {
      await setEveryone(owner.agent, ws, p.mono, null)
    }
  })
})

describe('jobs from a computer’s print window', () => {
  it('are refused at the slot when the limit is already reached, before any upload', async () => {
    await limit({ type: 'device', id: desk.clientId }, 0)
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE workspace_id = ?').bind(ws).first<{ n: number }>()
    const refused = await deviceJob(desk.token, p.color, 1)
    expect(refused).toMatchObject({ status: 403, body: { error: { code: 'policy_blocked', message: expect.stringContaining('Over the limit Pages') } } })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE workspace_id = ?').bind(ws).first<{ n: number }>()).toEqual(before)
  })

  it('are refused once the file is counted, and the job ends canceled with the message', async () => {
    await limit({ type: 'device', id: desk.clientId }, 5)
    const refused = await deviceJob(desk.token, p.color, 9)
    expect(refused).toMatchObject({ status: 403, body: { error: { code: 'policy_blocked', message: expect.stringContaining('this job needs 9 pages and 5 pages are left') } } })
    const job = ok(await owner.agent.get(jobsPath(ws)), 'jobs').items.find((j: { sourceClientId: string | null }) => j.sourceClientId === desk.clientId)
    expect(job).toMatchObject({ status: 'canceled', statusMessage: refused.body.error.message, hasFile: false })
  })
})
