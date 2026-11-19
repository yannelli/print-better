import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { grant, newGroup, ok, setEveryone, turnOnAccess, wsPath } from './helpers/access'
import { connectPrinter, Device, type Station } from './helpers/device'
import { call, nextIp, readReply, type Reply } from './helpers/http'
import { freshWorkspace, PDF } from './helpers/jobs'
import { enrollDevice, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: { close(): void }[] = []
afterEach(() => {
  for (const s of sockets.splice(0)) s.close()
})

interface World {
  ws: string
  laser: Station
  inkjet: Station
  desk: { clientId: string; token: string; device: Device }
}

/** Two printers on two devices, and a desktop that prints to them, in a workspace with printer access on. */
async function world(): Promise<World> {
  const ws = await freshWorkspace(owner)
  await turnOnAccess(owner, ws)
  const laser = await connectPrinter(owner, 'usb:laser', ws)
  const inkjet = await connectPrinter(owner, 'usb:inkjet', ws)
  const { clientId, token } = await enrollDevice(owner, ws)
  const device = await Device.connect(token)
  sockets.push(laser.device, inkjet.device, device)
  await device.hello({ os: 'macos' })
  return { ws, laser, inkjet, desk: { clientId, token, device } }
}

async function deviceCall(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const json = body !== undefined && !(body instanceof Uint8Array)
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': nextIp(), ...(json && { 'Content-Type': 'application/json' }), ...headers } }
  if (body !== undefined) init.body = json ? JSON.stringify(body) : (body as Uint8Array)
  return readReply(await call(path, init))
}

const slot = (token: string, printerId: string) =>
  deviceCall(token, 'POST', '/api/client/jobs', { printerId, contentType: 'application/pdf', size: PDF.byteLength, title: 'Report' })
const refusal = (status: number) => ({ status, body: { error: { code: 'printer_access_denied', message: "You can't print to this printer from this computer" } } })
/** The printers in the desk's next snapshot. */
const snapshot = async (device: Device) => (await device.next('remote_printers')).printers.map((p) => p.id).sort()

describe('device jobs with printer access on', () => {
  it('need the device to have print: 404 without view, 403 with view only', async () => {
    const w = await world()
    await setEveryone(owner.agent, w.ws, w.laser.printerId, 'none')
    await setEveryone(owner.agent, w.ws, w.inkjet.printerId, 'viewer')
    expect(await slot(w.desk.token, w.laser.printerId)).toMatchObject(refusal(404))
    expect(await slot(w.desk.token, w.inkjet.printerId)).toMatchObject(refusal(403))
    expect((await slot(w.desk.token, 'no-such-printer')).body.error.code).toBe('printer_not_found')

    await grant(owner.agent, w.ws, w.laser.printerId, { type: 'client', id: w.desk.clientId }, 'user')
    expect((await slot(w.desk.token, w.laser.printerId)).status).toBe(201)
    const groupId = await newGroup(owner.agent, w.ws, 'Desks', [{ type: 'client', id: w.desk.clientId }])
    await grant(owner.agent, w.ws, w.inkjet.printerId, { type: 'group', id: groupId }, 'user')
    expect((await slot(w.desk.token, w.inkjet.printerId)).status).toBe(201)
  })

  it('check again when the document arrives', async () => {
    const w = await world()
    const s = ok(await slot(w.desk.token, w.laser.printerId), 'slot')
    await setEveryone(owner.agent, w.ws, w.laser.printerId, 'none')
    const path = new URL(s.uploadUrl).pathname
    expect(await deviceCall(w.desk.token, 'PUT', path, PDF, { 'Content-Type': 'application/pdf' })).toMatchObject(refusal(404))
    await setEveryone(owner.agent, w.ws, w.laser.printerId, null)
    expect((await deviceCall(w.desk.token, 'PUT', path, PDF, { 'Content-Type': 'application/pdf' })).body.job.status).toBe('queued')
  })
})

describe('remote printers with printer access on', () => {
  it('offer a computer only the printers it may print to', async () => {
    const w = await world()
    expect(await snapshot(w.desk.device)).toEqual([w.inkjet.printerId, w.laser.printerId].sort())
    await setEveryone(owner.agent, w.ws, w.laser.printerId, 'viewer')
    expect(await snapshot(w.desk.device)).toEqual([w.inkjet.printerId])
    ok(await owner.agent.patch(wsPath(w.ws, '/access'), { defaultRole: 'none' }), 'default none')
    expect(await snapshot(w.desk.device)).toEqual([])

    await grant(owner.agent, w.ws, null, { type: 'client', id: w.desk.clientId }, 'user')
    expect(await snapshot(w.desk.device)).toEqual([w.inkjet.printerId, w.laser.printerId].sort())
    expect(await snapshot(w.laser.device)).toEqual([])
  })

  it('follow group membership changes', async () => {
    const w = await world()
    expect(await snapshot(w.desk.device)).toHaveLength(2)
    ok(await owner.agent.patch(wsPath(w.ws, '/access'), { defaultRole: 'none' }), 'default none')
    expect(await snapshot(w.desk.device)).toEqual([])
    const groupId = await newGroup(owner.agent, w.ws, 'Office desks')
    await grant(owner.agent, w.ws, w.inkjet.printerId, { type: 'group', id: groupId }, 'user')
    ok(await owner.agent.put(wsPath(w.ws, `/groups/${groupId}/members/client/${w.desk.clientId}`), {}), 'join')
    expect(await snapshot(w.desk.device)).toEqual([w.inkjet.printerId])
    ok(await owner.agent.del(wsPath(w.ws, `/groups/${groupId}/members/client/${w.desk.clientId}`)), 'leave')
    expect(await snapshot(w.desk.device)).toEqual([])
  })
})

describe('removing a device', () => {
  it('deletes its grants and group memberships', async () => {
    const w = await world()
    const groupId = await newGroup(owner.agent, w.ws, 'Kiosks', [{ type: 'client', id: w.desk.clientId }])
    await grant(owner.agent, w.ws, w.laser.printerId, { type: 'client', id: w.desk.clientId }, 'viewer')
    await grant(owner.agent, w.ws, null, { type: 'client', id: w.desk.clientId }, 'viewer')
    const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE client_id = ?`).bind(w.desk.clientId).first<{ n: number }>())?.n
    expect([await count('printer_grants'), await count('group_members')]).toEqual([2, 1])
    expect((await owner.agent.del(wsPath(w.ws, `/clients/${w.desk.clientId}`))).status).toBe(204)
    expect([await count('printer_grants'), await count('group_members')]).toEqual([0, 0])
    expect((await owner.agent.get(wsPath(w.ws, `/groups`))).body.find((g: { id: string }) => g.id === groupId).members).toEqual([])
  })
})
