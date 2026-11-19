import { env } from 'cloudflare:workers'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectPrinter, printerReport, type Station } from './helpers/device'
import { Agent, ORIGIN, readReply } from './helpers/http'
import { jobRow, jobsPath, PDF, sha256Hex } from './helpers/jobs'
import { routeFetch, stubFetch } from './helpers/outbound'
import { addMember, createPat, setupOwner, type Owner } from './helpers/world'

let owner: Owner
let s: Station
let spare: string
let ws: string
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  s = await connectPrinter(owner, 'usb:main')
  const network = ['n1', 'n2', 'n3', 'n4'].map((k) => printerReport(k, { local: false }))
  const config = await s.device.report([printerReport('usb:main'), ...network])
  spare = config.printers.find((p) => p.key === 'n1')?.id as string
})
afterAll(() => s.device.close())
afterEach(() => vi.restoreAllMocks())

const create = (body: Record<string, unknown>, agent = owner.agent) => agent.post(jobsPath(ws), body)
const put = async (agent: Agent, url: string, body: BodyInit, headers: Record<string, string>) =>
  readReply(await agent.fetch(new URL(url).pathname, { method: 'PUT', body, headers }))

describe('two-step upload', () => {
  it('opens an upload slot, then queues the job once the exact bytes arrive', async () => {
    const slot = await create({ printerId: s.printerId, upload: { fileName: 'scan.pdf', contentType: 'application/pdf', size: PDF.byteLength } })
    expect(slot.status).toBe(200)
    const id = slot.body.job.id
    expect(slot.body.job).toMatchObject({ status: 'uploading', hasFile: false, title: 'scan.pdf', fileName: 'scan.pdf', source: 'web', size: PDF.byteLength })
    expect(slot.body.uploadUrl).toBe(`${ORIGIN}/api/workspaces/${ws}/jobs/${id}/file`)

    const done = await put(owner.agent, slot.body.uploadUrl, PDF, { 'Content-Type': 'application/pdf' })
    expect(done.status).toBe(200)
    expect(done.body.job).toMatchObject({ id, status: 'queued', hasFile: true })
    expect((await jobRow(id))?.sha256).toBe(await sha256Hex(PDF))
    const again = await put(owner.agent, slot.body.uploadUrl, PDF, { 'Content-Type': 'application/pdf' })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('not_uploading')
  })

  it('rejects types outside the allowlist and sizes over the workspace limit', async () => {
    const upload = (contentType: string, size: number) => create({ printerId: s.printerId, upload: { fileName: 'x', contentType, size } })
    expect((await upload('application/zip', 10)).body.error.code).toBe('unsupported_type')
    expect((await upload('application/pdf', 0)).status).toBe(400)
    expect((await upload('application/pdf', 50 * 1024 * 1024 + 1)).status).toBe(400)
    await owner.agent.patch(`/api/workspaces/${ws}`, { settings: { maxUploadMb: 1 } })
    expect((await upload('application/pdf', 2 * 1024 * 1024)).status).toBe(400)
    await owner.agent.patch(`/api/workspaces/${ws}`, { settings: { maxUploadMb: 50 } })
    expect((await upload('application/pdf', 2 * 1024 * 1024)).status).toBe(200)
  })

  it('checks the uploaded Content-Type and length against the slot', async () => {
    const slot = await create({ printerId: s.printerId, upload: { fileName: 'doc.pdf', contentType: 'application/pdf', size: PDF.byteLength } })
    const wrongType = await put(owner.agent, slot.body.uploadUrl, PDF, { 'Content-Type': 'image/png' })
    expect(wrongType.status).toBe(415)
    expect(wrongType.body.error.code).toBe('unsupported_type')
    const short = await put(owner.agent, slot.body.uploadUrl, PDF.slice(0, 10), { 'Content-Type': 'application/pdf' })
    expect(short.status).toBe(400)
    expect(short.body.error.code).toBe('size_mismatch')
    const generic = await put(owner.agent, slot.body.uploadUrl, PDF, { 'Content-Type': 'application/octet-stream' })
    expect(generic.body.job.status).toBe('queued')
  })

  it('rejects a streamed body that ends early and keeps the slot open', async () => {
    const slot = await create({ printerId: s.printerId, upload: { fileName: 'doc.pdf', contentType: 'application/pdf', size: PDF.byteLength } })
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(PDF.slice(0, 20))
        c.close()
      },
    })
    const r = await put(owner.agent, slot.body.uploadUrl, stream, { 'Content-Type': 'application/pdf' })
    expect(r.body.error.code).toBe('size_mismatch')
    expect(await env.FILES.head(`jobs/${ws}/${slot.body.job.id}`)).toBeNull()
    expect((await jobRow(slot.body.job.id))?.status).toBe('uploading')
  })

  it('lets only the job creator or an admin upload the file', async () => {
    const author = await addMember(owner)
    const other = await addMember(owner)
    const slot = await create({ printerId: s.printerId, upload: { fileName: 'a.pdf', contentType: 'application/pdf', size: PDF.byteLength } }, author.agent)
    expect((await put(other.agent, slot.body.uploadUrl, PDF, { 'Content-Type': 'application/pdf' })).status).toBe(403)
    expect((await put(author.agent, slot.body.uploadUrl, PDF, { 'Content-Type': 'application/pdf' })).status).toBe(200)
  })
})

describe('inline documents', () => {
  it('turns text into a plain-text job titled by its first line', async () => {
    const r = await create({ printerId: s.printerId, text: '\n  Grocery list\nMilk\nEggs\n' })
    expect(r.body.job).toMatchObject({ status: 'queued', contentType: 'text/plain', title: 'Grocery list', hasFile: true })
    expect((await create({ printerId: s.printerId, text: '   ' })).status).toBe(400)
  })

  it('fetches url documents on the server', async () => {
    const { seen } = routeFetch({ 'https://docs.example/files/menu.pdf': () => new Response(PDF, { headers: { 'Content-Type': 'application/pdf' } }) })
    const r = await create({ printerId: s.printerId, url: 'https://docs.example/files/menu.pdf?v=2' })
    expect(r.body.job).toMatchObject({ title: 'menu.pdf', fileName: 'menu.pdf', size: PDF.byteLength, contentType: 'application/pdf' })
    expect(seen[0].headers.get('User-Agent')).toMatch(/^PrintBetter\//)
    expect(seen[0].headers.get('Accept')).toContain('application/pdf')
    expect((await jobRow(r.body.job.id))?.sha256).toBe(await sha256Hex(PDF))
  })

  it('reports url failures as fetch_failed or unsupported_type', async () => {
    routeFetch({
      'https://docs.example/missing.pdf': () => new Response('nope', { status: 404 }),
      'https://docs.example/page': () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
      'https://docs.example/empty.pdf': () => new Response(new Uint8Array(0), { headers: { 'Content-Type': 'application/pdf' } }),
    })
    const code = async (url: string) => (await create({ printerId: s.printerId, url })).body.error.code
    expect(await code('https://docs.example/missing.pdf')).toBe('fetch_failed')
    expect(await code('https://docs.example/page')).toBe('unsupported_type')
    expect(await code('https://docs.example/empty.pdf')).toBe('invalid_request')
    expect(await code('ftp://docs.example/a.pdf')).toBe('invalid_request')
    vi.restoreAllMocks()
    stubFetch(() => Promise.reject(new TypeError('connection refused')))
    expect(await code('https://down.example/a.pdf')).toBe('fetch_failed')
  })

  it('decodes base64 documents, tolerating line breaks', async () => {
    const encoded = b64(PDF).replace(/(.{20})/g, '$1\n')
    const r = await create({ printerId: s.printerId, base64: encoded, contentType: 'application/pdf', fileName: 'inline.pdf' })
    expect(r.body.job).toMatchObject({ title: 'inline.pdf', size: PDF.byteLength, status: 'queued' })
    expect((await jobRow(r.body.job.id))?.sha256).toBe(await sha256Hex(PDF))
    const bad = (body: Record<string, unknown>) => create({ printerId: s.printerId, ...body })
    expect((await bad({ base64: '***', contentType: 'application/pdf', fileName: 'x.pdf' })).status).toBe(400)
    expect((await bad({ base64: b64(PDF), contentType: 'application/zip', fileName: 'x.zip' })).body.error.code).toBe('unsupported_type')
    expect((await bad({ base64: b64(PDF), contentType: 'application/pdf' })).status).toBe(400)
  })

  it('requires exactly one document source and valid options', async () => {
    for (const body of [{}, { text: 'a', url: 'https://x.example/a.pdf' }, { text: 'a', base64: 'AA==' }]) {
      expect((await create({ printerId: s.printerId, ...body })).status).toBe(400)
    }
    expect((await create({ printerId: s.printerId, text: 'a', options: { copies: 0 } })).status).toBe(400)
    expect((await create({ printerId: s.printerId, text: 'a', options: { colour: 'red' } })).status).toBe(400)
    const ok = await create({ printerId: s.printerId, text: 'a', options: { copies: 2, sides: 'two-sided-long-edge', pageRanges: '1-2,4' } })
    expect(ok.body.job.options).toEqual({ copies: 2, sides: 'two-sided-long-edge', pageRanges: '1-2,4' })
  })

  it('accepts page ranges typed with spaces, as the print form allows', async () => {
    const r = await create({ printerId: s.printerId, text: 'a', options: { pageRanges: '1-2, 4' } })
    expect(r.status).toBe(200)
    expect(r.body.job.options).toEqual({ pageRanges: '1-2,4' })
  })
})

describe('printer selection and attribution', () => {
  it('falls back to the workspace default printer, else asks for one', async () => {
    const none = await create({ text: 'no printer' })
    expect(none.status).toBe(400)
    expect(none.body.error.code).toBe('printer_required')
    await owner.agent.patch(`/api/workspaces/${ws}`, { settings: { defaultPrinterId: s.printerId } })
    expect((await create({ text: 'default printer' })).body.job.printerId).toBe(s.printerId)
    await owner.agent.patch(`/api/workspaces/${ws}`, { settings: { defaultPrinterId: null } })
  })

  it('refuses printers that are not added or not in this workspace', async () => {
    const notAdded = await create({ printerId: spare, text: 'x' })
    expect(notAdded.status).toBe(409)
    expect(notAdded.body.error.code).toBe('printer_not_added')
    expect((await create({ printerId: 'no-such-printer', text: 'x' })).status).toBe(404)
    const other = (await owner.agent.post('/api/workspaces', { name: 'Elsewhere' })).body.id
    expect((await owner.agent.post(jobsPath(other), { printerId: s.printerId, text: 'x' })).status).toBe(404)
  })

  it('records the source: web for browser sessions, api for tokens; members may print', async () => {
    const api = new Agent({ token: await createPat(owner), origin: null })
    expect((await create({ printerId: s.printerId, text: 'via api' }, api)).body.job.source).toBe('api')
    const member = await addMember(owner)
    const r = await create({ printerId: s.printerId, text: 'from a member' }, member.agent)
    expect(r.body.job).toMatchObject({ source: 'web', userId: member.user.id })
  })
})
