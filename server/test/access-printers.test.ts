import { beforeAll, describe, expect, it } from 'vitest'
import { grant, ok, setEveryone, turnOnAccess, wsPath } from './helpers/access'
import { connectPrinter } from './helpers/device'
import { Agent, type Reply } from './helpers/http'
import { PDF } from './helpers/jobs'
import { insertToken } from './helpers/tokens'
import { addMember, createPat, setupOwner, type Owner, type Person } from './helpers/world'

let owner: Owner
let ws: string
let bob: Person
let admin: Person
let tuner: string

beforeAll(async () => {
  owner = await setupOwner()
  ws = owner.workspaceId
  await turnOnAccess(owner)
  bob = await addMember(owner)
  admin = await addMember(owner, 'admin')
  tuner = ok(await owner.agent.post(wsPath(ws, '/access/roles'), { name: 'Tuner', permissions: ['settings'] }), 'role').id
})

let keys = 0
/** An added printer whose device has gone offline, so commands answer at once with client_offline. */
async function printer(everyone: string | null = null): Promise<string> {
  const s = await connectPrinter(owner, `usb:p${++keys}`)
  s.device.close()
  if (everyone) await setEveryone(owner.agent, ws, s.printerId, everyone)
  return s.printerId
}

const BOB = () => ({ type: 'user' as const, id: bob.user.id })
const p = (id: string, rest = '') => wsPath(ws, `/printers/${id}${rest}`)
const code = (r: Reply) => [r.status, r.body?.error?.code ?? null]
const HIDDEN = [404, 'not_found']
const DENIED = [403, 'printer_access_denied']

async function attempts(agent: Agent, id: string): Promise<Record<string, unknown[]>> {
  return {
    get: code(await agent.get(p(id))),
    refresh: code(await agent.post(p(id, '/refresh'))),
    identify: code(await agent.post(p(id, '/identify'))),
    testPage: code(await agent.post(p(id, '/test-page'))),
    text: code(await agent.post(wsPath(ws, '/jobs'), { printerId: id, text: 'hello' })),
    upload: code(await agent.post(wsPath(ws, '/jobs'), { printerId: id, upload: { fileName: 'a.pdf', contentType: 'application/pdf', size: PDF.byteLength } })),
    patch: code(await agent.patch(p(id), { location: 'Hall' })),
    access: code(await agent.get(p(id, '/access'))),
  }
}

describe('printers with printer access on', () => {
  it('do not exist for people without view: left out of lists, 404 everywhere else', async () => {
    const id = await printer('none')
    expect((await bob.agent.get(wsPath(ws, '/printers'))).body.map((x: { id: string }) => x.id)).not.toContain(id)
    const all = await attempts(bob.agent, id)
    for (const [what, result] of Object.entries(all)) expect([what, ...result]).toEqual([what, ...HIDDEN])
    expect(code(await bob.agent.del(p(id)))).toEqual(HIDDEN)
    expect((await bob.agent.get(p(id))).body.error.message).toBe('Printer not found')
  })

  it('let viewers see and refresh, but not print, identify, change or share', async () => {
    const id = await printer('viewer')
    expect(await attempts(bob.agent, id)).toEqual({
      get: [200, null],
      refresh: [409, 'client_offline'],
      identify: DENIED,
      testPage: DENIED,
      text: DENIED,
      upload: DENIED,
      patch: DENIED,
      access: DENIED,
    })
    expect((await bob.agent.get(wsPath(ws, '/printers'))).body.map((x: { id: string }) => x.id)).toContain(id)
    expect((await bob.agent.post(p(id, '/test-page'))).body.error.message).toBe("You don't have permission to print to this printer")
  })

  it('need print for every way of printing, granted to the person on a restricted printer', async () => {
    const id = await printer('none')
    await grant(owner.agent, ws, id, BOB(), 'user')
    const all = await attempts(bob.agent, id)
    expect(all).toMatchObject({ get: [200, null], identify: [409, 'client_offline'], testPage: [200, null], text: [200, null], upload: [200, null], patch: DENIED })
  })

  it('need settings to rename, move, share, remove from the workspace or forget a printer', async () => {
    const id = await printer('user')
    expect(code(await bob.agent.patch(p(id), { settings: { lanShare: false } }))).toEqual(DENIED)
    await grant(owner.agent, ws, id, BOB(), tuner)
    expect((await bob.agent.patch(p(id), { name: 'Hall laser', settings: { lanShare: false } })).body).toMatchObject({ name: 'Hall laser', settings: { lanShare: false } })
    expect((await bob.agent.patch(p(id), { added: false })).body.added).toBe(false)
    expect((await bob.agent.patch(p(id), { added: true })).body.added).toBe(true)
    expect((await bob.agent.del(p(id))).status).toBe(204)
  })

  it('need access to see or change who can use a printer; workspace-wide changes stay with admins', async () => {
    const id = await printer('user')
    const carol = await addMember(owner)
    expect(code(await bob.agent.patch(p(id, '/access'), { everyoneRole: 'none' }))).toEqual(DENIED)
    await grant(owner.agent, ws, id, BOB(), 'manager')
    expect((await bob.agent.patch(p(id, '/access'), { everyoneRole: 'none' })).body).toMatchObject({ everyoneRole: 'none', effectiveEveryoneRole: 'none' })
    const theirs = await grant(bob.agent, ws, id, { type: 'user', id: carol.user.id }, 'viewer')
    expect((await carol.agent.get(p(id))).status).toBe(200)
    expect((await bob.agent.del(wsPath(ws, `/access/grants/${theirs.id}`))).status).toBe(204)
    expect(code(await carol.agent.get(p(id)))).toEqual(HIDDEN)

    expect(code(await bob.agent.post(wsPath(ws, '/access/grants'), { subject: { type: 'user', id: carol.user.id }, role: 'viewer' }))).toEqual([403, 'forbidden'])
    const wide = await grant(admin.agent, ws, null, { type: 'user', id: carol.user.id }, 'viewer')
    expect(code(await bob.agent.del(wsPath(ws, `/access/grants/${wide.id}`)))).toEqual([403, 'forbidden'])
    expect(code(await bob.agent.patch(wsPath(ws, '/access'), { defaultRole: 'viewer' }))).toEqual([403, 'forbidden'])
    expect((await carol.agent.get(p(id))).status).toBe(200)
  })

  it('never limit owners and admins', async () => {
    const id = await printer('none')
    for (const agent of [owner.agent, admin.agent]) {
      expect(await attempts(agent, id)).toMatchObject({ get: [200, null], testPage: [200, null], text: [200, null], patch: [200, null], access: [200, null] })
    }
  })

  it('apply to API tokens as their user, after the token’s own scope check', async () => {
    const id = await printer('none')
    const pat = new Agent({ token: await createPat(bob), origin: null })
    expect(code(await pat.get(p(id)))).toEqual(HIDDEN)
    await grant(owner.agent, ws, id, BOB(), 'viewer')
    expect((await pat.get(p(id))).status).toBe(200)
    const readOnly = new Agent({ token: await insertToken(bob.user.id, { scopes: ['read'] }), origin: null })
    expect(code(await readOnly.post(p(id, '/test-page')))).toEqual([403, 'insufficient_scope'])
    expect(code(await pat.post(p(id, '/test-page')))).toEqual(DENIED)
  })
})

describe('/access/me and summaries', () => {
  it('report what the caller may do on each printer they can see', async () => {
    const hidden = await printer('none')
    const shared = await printer('viewer')
    const mine = ok(await bob.agent.get(wsPath(ws, '/access/me')), 'me')
    expect(mine.managed).toBe(true)
    expect(mine.printers[hidden]).toBeUndefined()
    expect(mine.printers[shared]).toEqual(['view'])
    const rows = ok(await bob.agent.get(wsPath(ws, '/access/printers')), 'summaries')
    expect(rows.find((r: { printerId: string }) => r.printerId === shared)).toEqual({ printerId: shared, effectiveEveryoneRole: 'viewer', restricted: false, grants: 0 })
    expect(rows.find((r: { printerId: string }) => r.printerId === hidden)).toBeUndefined()
    const all = ok(await owner.agent.get(wsPath(ws, '/access/printers')), 'summaries')
    expect(all.find((r: { printerId: string }) => r.printerId === hidden)).toMatchObject({ restricted: true, effectiveEveryoneRole: 'none' })
  })
})
