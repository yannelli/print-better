import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CLIENT_SETTINGS } from '../shared/types'
import { Device, eventually } from './helpers/device'
import { call, readReply } from './helpers/http'
import { freshWorkspace } from './helpers/jobs'
import { enrollDevice, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: Device[] = []
async function connect(token: string): Promise<Device> {
  const device = await Device.connect(token)
  sockets.push(device)
  return device
}
afterEach(() => {
  for (const d of sockets.splice(0)) d.close()
})

const upgrade = (headers: Record<string, string>) => call('/api/client/ws', { headers: { Upgrade: 'websocket', 'X-PB-Protocol': '1', ...headers } }).then(readReply)
const clientOf = async (ws: string, id: string) => (await owner.agent.get(`/api/workspaces/${ws}/clients/${id}`)).body
const setServerSettingsAt = (id: string, at: number) => env.DB.prepare('UPDATE clients SET settings_updated_at = ? WHERE id = ?').bind(at, id).run()

describe('device socket upgrade', () => {
  it('requires a WebSocket upgrade', async () => {
    const { token } = await enrollDevice(owner)
    const r = await readReply(await call('/api/client/ws', { headers: { Authorization: `Bearer ${token}` } }))
    expect(r.status).toBe(426)
    expect(r.body.error.code).toBe('upgrade_required')
  })

  it('rejects a protocol version it does not speak', async () => {
    const { token } = await enrollDevice(owner)
    const r = await upgrade({ Authorization: `Bearer ${token}`, 'X-PB-Protocol': '2' })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('unsupported_protocol')
  })

  it('rejects missing, unknown and revoked device tokens', async () => {
    expect((await upgrade({})).status).toBe(401)
    expect((await upgrade({ Authorization: 'Bearer pbc_nope' })).body.error.code).toBe('invalid_token')
    const { clientId, token } = await enrollDevice(owner)
    expect((await owner.agent.del(`/api/workspaces/${owner.workspaceId}/clients/${clientId}`)).status).toBe(204)
    expect((await upgrade({ Authorization: `Bearer ${token}` })).status).toBe(401)
  })
})

describe('handshake', () => {
  it('closes with 4400 when the first message is not hello', async () => {
    const device = await connect((await enrollDevice(owner)).token)
    device.send({ type: 'printers', printers: [] })
    expect((await device.waitClosed()).code).toBe(4400)
  })

  it('closes with 4400 on invalid JSON and on a hello for another protocol', async () => {
    const { token } = await enrollDevice(owner)
    const garbled = await connect(token)
    garbled.ws.send('{not json')
    expect(await garbled.waitClosed()).toEqual({ code: 4400, reason: 'Invalid JSON' })
    const wrongVersion = await connect(token)
    wrongVersion.send({ type: 'hello', protocol: 2 })
    expect((await wrongVersion.waitClosed()).code).toBe(4400)
  })

  it('answers the ping keepalive with pong', async () => {
    const device = await connect((await enrollDevice(owner)).token)
    const pong = new Promise<string>((resolve) => device.ws.addEventListener('message', (e) => resolve(String(e.data))))
    device.ws.send('ping')
    expect(await pong).toBe('pong')
  })

  it('welcomes the device with its identity and settings, and marks it online', async () => {
    const { clientId, token } = await enrollDevice(owner)
    const before = Date.now()
    const welcome = await (await connect(token)).hello({ hostname: 'renamed-pi', version: '0.2.0' })
    expect(welcome).toMatchObject({ clientId, workspaceId: owner.workspaceId, name: 'office-pi', settings: DEFAULT_CLIENT_SETTINGS, printers: [] })
    expect(welcome.serverTime).toBeGreaterThanOrEqual(before)
    expect(await clientOf(owner.workspaceId, clientId)).toMatchObject({ online: true, hostname: 'renamed-pi', version: '0.2.0', os: 'linux' })
  })

  it('takes newer device settings on hello and keeps the server copy when the device is older', async () => {
    const newer = await enrollDevice(owner)
    await setServerSettingsAt(newer.clientId, 1_000)
    const won = await (await connect(newer.token)).hello({ settings: { ...DEFAULT_CLIENT_SETTINGS, tray: false }, settingsUpdatedAt: 5_000 })
    expect(won.settings.tray).toBe(false)
    expect(won.settingsUpdatedAt).toBe(5_000)

    const older = await enrollDevice(owner)
    await setServerSettingsAt(older.clientId, 10_000)
    const lost = await (await connect(older.token)).hello({ settings: { ...DEFAULT_CLIENT_SETTINGS, tray: false }, settingsUpdatedAt: 5_000 })
    expect(lost.settings.tray).toBe(true)
    expect(lost.settingsUpdatedAt).toBe(10_000)
  })

  it('clamps device settings timestamps from the future to the server clock', async () => {
    const { token } = await enrollDevice(owner)
    const welcome = await (await connect(token)).hello({ settings: { ...DEFAULT_CLIENT_SETTINGS, paused: true }, settingsUpdatedAt: Date.now() + 10 * 86_400_000 })
    expect(welcome.settings.paused).toBe(true)
    expect(welcome.settingsUpdatedAt).toBeLessThanOrEqual(Date.now())
  })

  it('ignores malformed device settings', async () => {
    const { token } = await enrollDevice(owner)
    const welcome = await (await connect(token)).hello({ settings: { tray: 'yes please' }, settingsUpdatedAt: Date.now() })
    expect(welcome.settings).toEqual(DEFAULT_CLIENT_SETTINGS)
  })
})

describe('connection lifecycle', () => {
  it('replaces an older socket for the same device with 4409', async () => {
    const { token } = await enrollDevice(owner)
    const first = await connect(token)
    await first.hello()
    const second = await connect(token)
    expect((await first.waitClosed()).code).toBe(4409)
    expect((await second.hello()).type).toBe('welcome')
  })

  it('marks the device offline once its socket closes', async () => {
    const { clientId, token } = await enrollDevice(owner)
    const device = await connect(token)
    await device.hello()
    device.close()
    await eventually(async () => expect((await clientOf(owner.workspaceId, clientId)).online).toBe(false))
  })

  it('closes sockets idle past 90 s on the alarm sweep', async () => {
    const ws = await freshWorkspace(owner)
    const { clientId, token } = await enrollDevice(owner, ws)
    const device = await connect(token)
    await device.hello()
    const hub = env.HUB.getByName(ws)
    await runInDurableObject(hub, (_instance, state) => {
      for (const socket of state.getWebSockets()) socket.serializeAttachment({ ...socket.deserializeAttachment(), seenAt: 0 })
    })
    expect(await runDurableObjectAlarm(hub)).toBe(true)
    expect((await device.waitClosed()).code).toBe(1001)
    await eventually(async () => expect((await clientOf(ws, clientId)).online).toBe(false))
  })
})

describe('settings sync', () => {
  it('accepts newer device settings and echoes the winner', async () => {
    const { clientId, token } = await enrollDevice(owner)
    const device = await connect(token)
    const welcome = await device.hello()
    device.send({ type: 'settings', settings: { ...DEFAULT_CLIENT_SETTINGS, paused: true }, updatedAt: welcome.settingsUpdatedAt + 1 })
    const echo = await device.next('settings')
    expect(echo).toMatchObject({ settings: { paused: true }, updatedAt: welcome.settingsUpdatedAt + 1 })
    expect((await clientOf(owner.workspaceId, clientId)).settings.paused).toBe(true)
  })

  it('answers stale device settings with the server copy', async () => {
    const { clientId, token } = await enrollDevice(owner)
    await setServerSettingsAt(clientId, 50_000)
    const device = await connect(token)
    await device.hello()
    device.send({ type: 'settings', settings: { ...DEFAULT_CLIENT_SETTINGS, paused: true }, updatedAt: 40_000 })
    expect(await device.next('settings')).toMatchObject({ settings: { paused: false }, updatedAt: 50_000 })
  })

  it('pushes settings edited in the web app to the connected device', async () => {
    const { clientId, token } = await enrollDevice(owner)
    const device = await connect(token)
    const welcome = await device.hello()
    const r = await owner.agent.patch(`/api/workspaces/${owner.workspaceId}/clients/${clientId}`, { settings: { tray: false, discovery: { snmp: false } } })
    expect(r.status).toBe(200)
    const pushed = await device.next('settings')
    expect(pushed.settings).toMatchObject({ tray: false, discovery: { snmp: false, mdns: true } })
    expect(pushed.updatedAt).toBeGreaterThan(welcome.settingsUpdatedAt)
  })
})
