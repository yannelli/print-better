import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ok, setEveryone, turnOnAccess, wsPath } from './helpers/access'
import { connectPrinter, type Station } from './helpers/device'
import { EventSocket, jobsPath } from './helpers/jobs'
import { callTool, modern } from './helpers/mcp'
import { entriesIn, preview, switchExtension, turnOnPolicies } from './helpers/usage'
import { addMember, createPat, setupOwner, type Owner, type Person } from './helpers/world'

const ZERO = { bwPageMicros: 0, colorPageMicros: 0, duplexSheetDiscountMicros: 0 }
const PRICES = { bwPageMicros: 50_000, colorPageMicros: 250_000, duplexSheetDiscountMicros: 10_000 }
const OFF = 'Print rules and limits and Enterprise controls are turned off for this workspace.'

let owner: Owner
let member: Person
let s: Station
let ws: string

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  member = await addMember(owner)
  s = await connectPrinter(owner, 'usb:prices')
})
afterAll(() => s.device.close())

const prices = (agent = owner.agent) => agent.get(wsPath(ws, '/prices'))
const setPrices = (body: unknown, agent = owner.agent) => agent.put(wsPath(ws, '/prices'), body)
const jobCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE workspace_id = ?').bind(ws).first<{ n: number }>())?.n

describe('with both usage extensions off', () => {
  it('answers 404 extension_inactive on the shared routes', async () => {
    const replies = [await prices(), await setPrices({ currency: 'EUR' }), await preview(owner.agent, ws, { printerId: s.printerId, contentType: 'application/pdf', size: 10 })]
    for (const reply of replies) {
      expect(reply.status).toBe(404)
      expect(reply.body.error.code).toBe('extension_inactive')
      expect(reply.body.error.message).toContain(OFF)
    }
  })
})

describe('prices', () => {
  beforeAll(() => turnOnPolicies(owner, ws))

  it('start at USD, UTC and no prices; members read them and only admins change them', async () => {
    expect(ok(await prices(member.agent), 'prices')).toEqual({ currency: 'USD', timeZone: 'UTC', default: ZERO, printers: {} })
    expect((await setPrices({ currency: 'EUR' }, member.agent)).status).toBe(403)
    const own = { bwPageMicros: 20_000, colorPageMicros: 20_000, duplexSheetDiscountMicros: 0 }
    const saved = ok(await setPrices({ currency: 'eur', timeZone: 'europe/paris', default: PRICES, printers: { [s.printerId]: own } }), 'save')
    expect(saved).toEqual({ currency: 'EUR', timeZone: 'Europe/Paris', default: PRICES, printers: { [s.printerId]: own } })
    expect(ok(await prices(member.agent), 'prices')).toEqual(saved)
    expect(ok(await setPrices({ printers: { [s.printerId]: null } }), 'reset')).toEqual({ ...saved, printers: {} })
  })

  it('refuses unknown currencies, time zones, printers, fields and amounts, and keeps what was saved', async () => {
    const before = ok(await prices(), 'prices')
    const bad = [
      { currency: 'DOLLARS' },
      { currency: 'ZZZ' },
      { timeZone: 'Mars/Olympus' },
      { printers: { nope: PRICES } },
      { default: { ...PRICES, bwPageMicros: -1 } },
      { default: { ...PRICES, bwPageMicros: 1.5 } },
      { default: { bwPageMicros: 1 } },
      { default: { ...PRICES, perPage: 1 } },
      { colour: 'blue' },
    ]
    for (const body of bad) expect((await setPrices(body)).status, JSON.stringify(body)).toBe(400)
    expect((await setPrices({ printers: { nope: PRICES } })).body.error.message).toBe('Printer not found: nope')
    expect(ok(await prices(), 'prices')).toEqual(before)
  })

  it('audits each change and tells open pages', async () => {
    const events = await EventSocket.open(owner.agent, ws)
    try {
      ok(await setPrices({ currency: 'USD' }), 'save')
      await events.next('usage')
      const audit = await env.DB.prepare("SELECT target, data FROM audit_log WHERE workspace_id = ? AND action = 'prices.update' ORDER BY id DESC").bind(ws).first()
      expect(audit).toEqual({ target: ws, data: JSON.stringify({ fields: ['currency'] }) })
    } finally {
      events.close()
    }
  })

  it('shows members only the prices of printers they can see', async () => {
    const hidden = await connectPrinter(owner, 'usb:hidden-prices')
    try {
      ok(await setPrices({ printers: { [hidden.printerId]: PRICES, [s.printerId]: PRICES } }), 'save')
      await turnOnAccess(owner, ws)
      await setEveryone(owner.agent, ws, hidden.printerId, 'none')
      expect(Object.keys(ok(await prices(member.agent), 'prices').printers)).toEqual([s.printerId])
      expect(Object.keys(ok(await prices(), 'prices').printers).sort()).toEqual([hidden.printerId, s.printerId].sort())
    } finally {
      await switchExtension(owner, 'printer-access', ws, false)
      ok(await setPrices({ printers: { [hidden.printerId]: null, [s.printerId]: null } }), 'reset')
      hidden.device.close()
    }
  })
})

describe('job preview', () => {
  beforeAll(async () => {
    await turnOnPolicies(owner, ws)
    ok(await setPrices({ default: PRICES }), 'prices')
  })

  it('shows pages, sheets, cost and the printer, storing and sending nothing', async () => {
    const jobs = await jobCount()
    const body = { printerId: s.printerId, contentType: 'application/pdf', size: 1000, documentPages: 10, options: { copies: 2, sides: 'two-sided-long-edge' } }
    expect(ok(await preview(member.agent, ws, body), 'preview')).toEqual({
      block: null,
      printerId: s.printerId,
      options: { copies: 2, sides: 'two-sided-long-edge' },
      notes: [],
      hold: null,
      costCenterId: null,
      // 20 pages at 0.05, less 0.01 for each of the 10 two-sided sheets.
      usage: { documentPages: 10, pages: 20, sheets: 10, colorPages: 0, costMicros: 900_000, estimated: true },
      meters: [],
    })
    expect(await jobCount()).toBe(jobs)
    expect(await entriesIn(ws)).toEqual([])
  })

  it('counts a tiny document it can’t count as 1 page per copy, and checks the request like POST /jobs', async () => {
    const counted = ok(await preview(member.agent, ws, { printerId: s.printerId, contentType: 'text/plain', size: 10, options: { copies: 3 } }), 'preview')
    expect(counted.usage).toMatchObject({ documentPages: null, pages: 3, sheets: 3 })
    const cases: [unknown, number, string?][] = [
      [{ printerId: s.printerId, size: 10 }, 400],
      [{ printerId: s.printerId, contentType: 'application/pdf', size: 500 * 1024 * 1024 }, 400, 'too_large'],
      [{ printerId: s.printerId, contentType: 'application/pdf', size: 10, options: { colour: 'blue' } }, 400],
      [{ printerId: s.printerId, contentType: 'application/pdf', size: 10, documentPages: 0 }, 400],
      [{ printerId: 'nope', contentType: 'application/pdf', size: 10 }, 404],
      [{ contentType: 'application/pdf', size: 10 }, 400, 'printer_required'],
    ]
    for (const [body, status, code] of cases) {
      const reply = await preview(member.agent, ws, body)
      expect(reply.status, JSON.stringify(body)).toBe(status)
      if (code) expect(reply.body.error.code).toBe(code)
    }
  })

  it('estimates from the size the pages of documents it can’t count, leaning high', async () => {
    const text = ok(await preview(member.agent, ws, { printerId: s.printerId, contentType: 'text/plain', size: 9 * 1024 * 1024 }), 'long text')
    expect(text.usage).toMatchObject({ documentPages: null, pages: 3146 })
    const broken = `%PDF-1.7\n${'x'.repeat(59_991)}`
    const job = ok(await member.agent.post(jobsPath(ws), { printerId: s.printerId, base64: btoa(broken), contentType: 'application/pdf', fileName: 'broken.pdf' }), 'job').job
    expect(job.usage).toMatchObject({ documentPages: null, pages: 3 })
  })

  it('needs print on the printer', async () => {
    try {
      await turnOnAccess(owner, ws)
      await setEveryone(owner.agent, ws, s.printerId, 'viewer')
      const refused = await preview(member.agent, ws, { printerId: s.printerId, contentType: 'application/pdf', size: 10 })
      expect(refused).toMatchObject({ status: 403, body: { error: { code: 'printer_access_denied' } } })
    } finally {
      await switchExtension(owner, 'printer-access', ws, false)
    }
  })
})

describe('MCP', () => {
  const SHARED = ['get_prices', 'set_prices', 'preview_print_job']
  const listed = async (token: string) => ((await modern(token, 'tools/list')).body.result.tools as { name: string }[]).map((t) => t.name)

  it('lists the shared tools while the extension is available, and runs them where it is on', async () => {
    await turnOnPolicies(owner, ws)
    const token = await createPat(owner, ws)
    expect(await listed(token)).toEqual(expect.arrayContaining(SHARED))
    const saved = await callTool(token, 'set_prices', { currency: 'USD', default: PRICES })
    expect(saved.summary).toContain('$0.05 per black-and-white page, $0.25 per color page, $0.01 off each two-sided sheet')
    expect((await callTool(token, 'get_prices')).data.prices).toMatchObject({ currency: 'USD', default: PRICES })
    const previewed = await callTool(token, 'preview_print_job', { printerId: s.printerId, contentType: 'application/pdf', size: 1000, documentPages: 3 })
    expect(previewed.summary).toBe(`It would print 3 pages on 3 sheets, about $0.15, on printer ${s.printerId}.`)

    await switchExtension(owner, 'print-policies', ws, false)
    const refused = await callTool(token, 'get_prices')
    expect(refused.isError).toBe(true)
    expect(refused.summary).toContain(OFF)

    ok(await owner.agent.patch('/api/admin/extensions/print-policies', { available: false }), 'unavailable')
    expect(await listed(token)).not.toEqual(expect.arrayContaining([SHARED[0]]))
  })
})
