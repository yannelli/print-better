import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { grant, ok, setEveryone, turnOnAccess } from './helpers/access'
import { connectPrinter, Device, eventually, type Station } from './helpers/device'
import { Agent, call, readReply } from './helpers/http'
import { freshWorkspace, PDF } from './helpers/jobs'
import { enrollDevice, jsonInit, setupOwner, type Owner } from './helpers/world'

const PHONE = { hostname: 'iPhone', os: 'ios', arch: 'arm64', version: '1.0', name: 'Front Desk iPhone' }
const TABLET = { ...PHONE, hostname: 'iPad', os: 'ipados', name: 'Front Desk iPad' }

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: Device[] = []
afterEach(() => {
  for (const d of sockets.splice(0)) d.close()
})

interface World {
  ws: string
  laser: Station
  inkjet: Station
  phone: { clientId: string; agent: Agent }
}

async function pairPhone(ws: string, device = PHONE): Promise<{ clientId: string; agent: Agent }> {
  const enrollment = ok(await owner.agent.post(`/api/workspaces/${ws}/enrollments`, { label: device.hostname }), 'enrollment')
  const paired = ok(await readReply(await call('/api/client/enroll', jsonInit({ token: enrollment.token, ...device }))), 'enroll')
  return { clientId: paired.clientId, agent: new Agent({ token: paired.token }) }
}

/** Two printers on two devices, and an iPhone that prints to them without ever opening a socket. */
async function world(): Promise<World> {
  const ws = await freshWorkspace(owner, 'Studio')
  const laser = await connectPrinter(owner, 'usb:laser', ws)
  const inkjet = await connectPrinter(owner, 'usb:inkjet', ws)
  sockets.push(laser.device, inkjet.device)
  return { ws, laser, inkjet, phone: await pairPhone(ws) }
}

const printerIds = async (phone: Agent): Promise<string[]> => ok(await phone.get('/api/client/printers'), 'printers').printers.map((p: { id: string }) => p.id).sort()

async function printFromPhone(phone: Agent, printerId: string, title: string): Promise<string> {
  const slot = ok(await phone.post('/api/client/jobs', { printerId, contentType: 'application/pdf', size: PDF.byteLength, title }), 'slot')
  const put = await readReply(await phone.fetch(new URL(slot.uploadUrl).pathname, { method: 'PUT', body: PDF, headers: { 'Content-Type': 'application/pdf' } }))
  expect(put.status).toBe(200)
  return slot.job.id
}

describe('an iPhone or iPad', () => {
  it('pairs as an iPhone with a pairing code or a device code', async () => {
    const w = await world()
    const listed = ok(await owner.agent.get(`/api/workspaces/${w.ws}/clients/${w.phone.clientId}`), 'client')
    expect(listed).toMatchObject({ name: 'Front Desk iPhone', os: 'ios', arch: 'arm64', online: false, lastSeenAt: null })

    const code = ok(await readReply(await call('/api/client/device/code', jsonInit(PHONE))), 'device code')
    expect(ok(await owner.agent.get(`/api/device/${code.userCode}`), 'describe')).toMatchObject({ hostname: 'iPhone', os: 'ios' })
  })

  it('pairs an iPad as an iPad', async () => {
    const ws = await freshWorkspace(owner, 'Studio')
    const tablet = await pairPhone(ws, TABLET)
    expect(ok(await owner.agent.get(`/api/workspaces/${ws}/clients/${tablet.clientId}`), 'client')).toMatchObject({ name: 'Front Desk iPad', os: 'ipados' })
  })

  it('reads the same printers a desktop gets in its remote printers snapshot', async () => {
    const w = await world()
    const desk = await enrollDevice(owner, w.ws)
    const socket = await Device.connect(desk.token)
    sockets.push(socket)
    await socket.hello({ os: 'macos' })
    const snapshot = (await socket.next('remote_printers')).printers
    const { printers } = ok(await w.phone.agent.get('/api/client/printers'), 'printers')
    expect(printers).toEqual(snapshot)
    expect(printers.map((p: { id: string }) => p.id).sort()).toEqual([w.inkjet.printerId, w.laser.printerId].sort())
    expect(printers[0]).toMatchObject({ online: true, state: 'idle', supplies: [], clientName: expect.any(String) })
  })

  it('reads only the printers it may print to while printer access is on', async () => {
    const w = await world()
    await turnOnAccess(owner, w.ws)
    await setEveryone(owner.agent, w.ws, w.laser.printerId, 'viewer')
    expect(await printerIds(w.phone.agent)).toEqual([w.inkjet.printerId])
    await grant(owner.agent, w.ws, w.laser.printerId, { type: 'client', id: w.phone.clientId }, 'user')
    expect(await printerIds(w.phone.agent)).toEqual([w.inkjet.printerId, w.laser.printerId].sort())
  })

  it('lists only its own jobs, newest first, a page at a time', async () => {
    const w = await world()
    const desk = new Agent({ token: (await enrollDevice(owner, w.ws)).token })
    const first = await printFromPhone(w.phone.agent, w.laser.printerId, 'Boarding pass')
    await printFromPhone(desk, w.laser.printerId, 'Not mine')
    const second = await printFromPhone(w.phone.agent, w.inkjet.printerId, 'Recipe')
    await env.DB.prepare('UPDATE jobs SET created_at = created_at - 1000 WHERE id = ?').bind(first).run()

    const all = ok(await w.phone.agent.get('/api/client/jobs'), 'jobs')
    expect(all.items.map((j: { id: string }) => j.id)).toEqual([second, first])
    expect(all.items[0]).toMatchObject({ title: 'Recipe', status: 'queued', source: 'device', sourceClientName: 'Front Desk iPhone' })
    expect(all.nextCursor).toBeNull()

    const page = ok(await w.phone.agent.get('/api/client/jobs?limit=1'), 'page 1')
    expect(page.items.map((j: { id: string }) => j.id)).toEqual([second])
    const rest = ok(await w.phone.agent.get(`/api/client/jobs?limit=1&cursor=${page.nextCursor}`), 'page 2')
    expect(rest.items.map((j: { id: string }) => j.id)).toEqual([first])
  })

  it('learns its own name and workspace', async () => {
    const w = await world()
    expect(ok(await w.phone.agent.get('/api/client/me'), 'me')).toEqual({
      clientId: w.phone.clientId,
      name: 'Front Desk iPhone',
      workspaceId: w.ws,
      workspaceName: 'Studio',
    })
  })

  it('is never offered a client update', async () => {
    const w = await world()
    await env.FILES.put('downloads/latest.json', JSON.stringify({ version: '9.0.0', files: { 'macos-universal': { name: 'a.zip', sha256: 'a'.repeat(64), size: 1 } } }))
    const tablet = await pairPhone(w.ws, TABLET)
    for (const agent of [w.phone.agent, tablet.agent]) {
      const reply = await agent.get('/api/client/latest?os=macos&arch=aarch64')
      expect(reply.status).toBe(404)
      expect(reply.body.error.code).toBe('no_build')
    }
  })

  it('records when it was last used, since it never stays connected', async () => {
    const w = await world()
    const lastSeen = async () => ok(await owner.agent.get(`/api/workspaces/${w.ws}/clients/${w.phone.clientId}`), 'client').lastSeenAt
    expect(await lastSeen()).toBeNull()
    const before = Date.now()
    await w.phone.agent.get('/api/client/printers')
    await eventually(async () => expect(await lastSeen()).toBeGreaterThanOrEqual(before))
  })

  it('needs its token everywhere', async () => {
    for (const path of ['/api/client/me', '/api/client/printers', '/api/client/jobs']) {
      const reply = await readReply(await call(path, { headers: { Authorization: 'Bearer pbc_nope' } }))
      expect(reply.status, path).toBe(401)
    }
  })
})
