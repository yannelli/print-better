import { env } from 'cloudflare:workers'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ok, setEveryone, turnOnAccess } from './helpers/access'
import { readReply } from './helpers/http'
import { connectPrinter, eventually } from './helpers/device'
import { jobsPath } from './helpers/jobs'
import { addMember, setupOwner, type Owner, type Person } from './helpers/world'
import { auditOf, entriesOf, office, type Office, pdfJob, pdfOf, preview, rulesPath, switchExtension, turnOnPolicies } from './helpers/usage'

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
  for (const rule of ok(await owner.agent.get(rulesPath(ws)), 'rules')) await owner.agent.del(rulesPath(ws, `/${rule.id}`))
})

const rule = async (body: unknown) => ok(await owner.agent.post(rulesPath(ws), body), 'create rule')
const BIG = { pages: { min: 10 } }

describe('rule actions on real jobs', () => {
  it('block with the rule’s message, storing nothing, and audit the refusal', async () => {
    await rule({ name: 'Copier only', conditions: BIG, actions: [{ type: 'block', message: 'Send jobs of 10 pages or more to the copier.' }] })
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>()
    const refused = await pdfJob(member.agent, ws, p.color, 12)
    expect(refused).toMatchObject({ status: 403, body: { error: { code: 'policy_blocked', message: 'Send jobs of 10 pages or more to the copier.' } } })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>()).toEqual(before)
    expect((await auditOf(ws, 'job.block')).at(-1)).toMatchObject({ data: expect.stringContaining('Send jobs of 10 pages or more to the copier.') })
    expect((await pdfJob(member.agent, ws, p.color, 9)).status).toBe(200)
  })

  it('refuse an upload once its file is counted: the file goes, the job is canceled with the message', async () => {
    await rule({ name: 'Copier only', conditions: BIG, actions: [{ type: 'block', message: 'Too big for this printer.' }] })
    const bytes = pdfOf(12)
    const slot = ok(await member.agent.post(jobsPath(ws), { printerId: p.color, upload: { fileName: 'big.pdf', contentType: 'application/pdf', size: bytes.length } }), 'slot')
    const put = await readReply(await member.agent.fetch(new URL(slot.uploadUrl).pathname, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/pdf' } }))
    expect(put).toMatchObject({ status: 403, body: { error: { code: 'policy_blocked', message: 'Too big for this printer.' } } })
    const job = ok(await member.agent.get(jobsPath(ws) + `/${slot.job.id}`), 'job')
    expect(job).toMatchObject({ status: 'canceled', statusMessage: 'Too big for this printer.', hasFile: false })
    expect(await entriesOf(job.id)).toEqual([])
  })

  it('change options with a note for each change, keeping what the sender asked for', async () => {
    await rule({ name: 'Save paper', conditions: BIG, actions: [{ type: 'two-sided' }, { type: 'monochrome' }, { type: 'max-copies', copies: 2 }, { type: 'note', message: 'Thanks' }] })
    const job = ok(await pdfJob(member.agent, ws, p.color, 12, { copies: 3 }), 'job').job
    expect(job.options).toEqual({ copies: 2, sides: 'two-sided-long-edge', colorMode: 'monochrome' })
    expect(job.policy).toEqual({
      notes: ['Printed two-sided', 'Printed in black and white', 'Copies limited to 2', 'Thanks'].map((message) => ({ source: 'rule', id: expect.any(String), name: 'Save paper', message })),
      requested: { printerId: p.color, options: { copies: 3 } },
    })
    expect(job.usage).toEqual({ documentPages: 12, pages: 24, sheets: 12, colorPages: 0, costMicros: 0, estimated: true })
    expect(await entriesOf(job.id)).toMatchObject([{ attempt: 1, pages: 24, sheets: 12, color_pages: 0, estimated: 1, user_id: member.user.id, printer_id: p.color }])
  })

  it('note only what really changed', async () => {
    await rule({ name: 'Save paper', actions: [{ type: 'two-sided' }, { type: 'monochrome' }, { type: 'max-copies', copies: 5 }] })
    const onMono = ok(await pdfJob(member.agent, ws, p.mono, 3), 'job').job
    expect(onMono.policy).toBeUndefined()
    expect(onMono.options).toEqual({})
  })

  it('let later rules see what earlier ones did, and stop at a block', async () => {
    const fewer = await rule({ name: 'One copy of big jobs', conditions: { pages: { min: 20 } }, actions: [{ type: 'max-copies', copies: 1 }] })
    const block = await rule({ name: 'No huge jobs', conditions: { pages: { min: 20 } }, actions: [{ type: 'block', message: 'Too many pages.' }] })
    expect(ok(await pdfJob(member.agent, ws, p.color, 10, { copies: 3 }), 'job').job.usage.pages).toBe(10)
    ok(await owner.agent.put(rulesPath(ws, '/order'), { ids: [block.id, fewer.id] }), 'reorder')
    expect((await pdfJob(member.agent, ws, p.color, 10, { copies: 3 })).body.error.message).toBe('Too many pages.')
  })

  it('send a job to another printer only when the sender may print there', async () => {
    await rule({ name: 'Mono first', conditions: { color: false }, actions: [{ type: 'redirect', printerId: p.mono }] })
    const moved = ok(await pdfJob(member.agent, ws, p.color, 2, { colorMode: 'monochrome' }), 'job').job
    expect(moved).toMatchObject({ printerId: p.mono, policy: { notes: [{ message: 'Sent to Mono printer' }], requested: { printerId: p.color } } })
    try {
      await turnOnAccess(owner, ws)
      await setEveryone(owner.agent, ws, p.mono, 'viewer')
      const stayed = ok(await pdfJob(member.agent, ws, p.color, 2, { colorMode: 'monochrome' }), 'job').job
      expect(stayed).toMatchObject({ printerId: p.color, policy: { notes: [{ message: "Not sent to Mono printer, since the sender can't print there" }] } })
    } finally {
      await switchExtension(owner, 'printer-access', ws, false)
    }
  })

  it('keep a job on its printer, with a note, when the printer a rule sends it to is offline', async () => {
    const far = await connectPrinter(owner, 'usb:far', ws)
    far.device.close()
    await eventually(async () => expect(await env.DB.prepare('SELECT online FROM clients WHERE id = ?').bind(far.clientId).first('online')).toBe(0))
    await rule({ name: 'Overflow', actions: [{ type: 'redirect', printerId: far.printerId }] })
    const stayed = ok(await pdfJob(member.agent, ws, p.color, 2), 'job').job
    expect(stayed).toMatchObject({ printerId: p.color, policy: { notes: [{ message: 'Not sent to Printer usb:far, since office-pi is offline' }] } })
  })

  it('wait for the page count before a rule about pages refuses an upload', async () => {
    await rule({ name: 'Short jobs elsewhere', conditions: { pages: { max: 5 } }, actions: [{ type: 'block', message: 'Print short jobs on the mono printer.' }] })
    const upload = async (pages: number) => {
      const bytes = pdfOf(pages)
      const slot = ok(await member.agent.post(jobsPath(ws), { printerId: p.color, upload: { fileName: 'doc.pdf', contentType: 'application/pdf', size: bytes.length } }), 'slot')
      return readReply(await member.agent.fetch(new URL(slot.uploadUrl).pathname, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/pdf' } }))
    }
    expect((await upload(12)).body.job).toMatchObject({ status: 'queued' })
    expect(await upload(3)).toMatchObject({ status: 403, body: { error: { code: 'policy_blocked', message: 'Print short jobs on the mono printer.' } } })
  })

  it('skip approval and release without Enterprise controls, so the job prints', async () => {
    await rule({ name: 'Check first', actions: [{ type: 'approval' }, { type: 'release' }] })
    const job = ok(await pdfJob(member.agent, ws, p.color, 1), 'job').job
    expect(job.status).toBe('queued')
    expect(job).not.toHaveProperty('held')
    expect(job).not.toHaveProperty('policy')
  })

  it('leave owners and admins alone when a rule says so, and skip rules that are off', async () => {
    await rule({ name: 'Members only', exemptAdmins: true, actions: [{ type: 'block', message: 'Members can’t print now.' }] })
    expect((await pdfJob(owner.agent, ws, p.color, 1)).status).toBe(200)
    expect((await pdfJob(member.agent, ws, p.color, 1)).status).toBe(403)
    await rule({ name: 'Off', enabled: false, actions: [{ type: 'block', message: 'Never.' }] })
    expect((await pdfJob(owner.agent, ws, p.color, 1)).status).toBe(200)
  })

  it('preview the same decision the real job gets', async () => {
    await rule({ name: 'Save paper', conditions: BIG, actions: [{ type: 'two-sided' }, { type: 'redirect', printerId: p.mono }, { type: 'note', message: 'Moved' }] })
    const options = { copies: 2 }
    const seen = ok(await preview(member.agent, ws, { printerId: p.color, contentType: 'application/pdf', size: 1000, documentPages: 11, options }), 'preview')
    const job = ok(await pdfJob(member.agent, ws, p.color, 11, options), 'job').job
    expect(seen).toMatchObject({ block: null, printerId: job.printerId, options: job.options, notes: job.policy.notes, usage: job.usage })
  })

  it('start a retry from what the sender asked for', async () => {
    const saver = await rule({ name: 'Save paper', actions: [{ type: 'monochrome' }] })
    const job = ok(await pdfJob(member.agent, ws, p.color, 4), 'job').job
    expect(job.options).toEqual({ colorMode: 'monochrome' })
    ok(await member.agent.post(`${jobsPath(ws)}/${job.id}/cancel`), 'cancel')
    ok(await owner.agent.patch(rulesPath(ws, `/${saver.id}`), { enabled: false }), 'turn off')
    const retried = ok(await member.agent.post(`${jobsPath(ws)}/${job.id}/retry`), 'retry')
    expect(retried).toMatchObject({ status: 'queued', attempts: 2, options: {}, printerId: p.color })
    expect(retried).not.toHaveProperty('policy')
    expect((await entriesOf(job.id)).map((e) => [e.attempt, e.pages])).toEqual([
      [1, 0],
      [2, 4],
    ])
  })

  it('retry on the printer the job is on once the sender may no longer print to the one asked for', async () => {
    const mono = await rule({ name: 'Mono first', conditions: { color: false }, actions: [{ type: 'redirect', printerId: p.mono }] })
    const job = ok(await pdfJob(member.agent, ws, p.color, 2, { colorMode: 'monochrome' }), 'job').job
    expect(job).toMatchObject({ printerId: p.mono, policy: { requested: { printerId: p.color } } })
    ok(await member.agent.post(`${jobsPath(ws)}/${job.id}/cancel`), 'cancel')
    ok(await owner.agent.patch(rulesPath(ws, `/${mono.id}`), { enabled: false }), 'turn off')
    try {
      await turnOnAccess(owner, ws)
      await setEveryone(owner.agent, ws, p.mono, null)
      await setEveryone(owner.agent, ws, p.color, 'viewer')
      expect(ok(await member.agent.post(`${jobsPath(ws)}/${job.id}/retry`), 'retry')).toMatchObject({ status: 'queued', attempts: 2, printerId: p.mono })
    } finally {
      await setEveryone(owner.agent, ws, p.color, null)
      await switchExtension(owner, 'printer-access', ws, false)
    }
  })
})
