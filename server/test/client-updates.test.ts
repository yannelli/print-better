import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { connectPrinter, Device } from './helpers/device'
import { Agent, ORIGIN } from './helpers/http'
import { freshWorkspace } from './helpers/jobs'
import { addMember, enrollDevice, setupOwner, type Owner } from './helpers/world'

const entry = (name: string, fill: string, size: number) => ({ name, sha256: fill.repeat(64), size })
const MANIFEST = {
  version: '0.3.0',
  files: {
    'macos-universal': entry('printbetter-0.3.0-macos-universal.zip', 'a', 11),
    'macos-pkg': entry('PrintBetter-0.3.0.pkg', 'b', 12),
    'linux-x86_64': entry('printbetter-0.3.0-linux-x86_64.tar.gz', 'c', 13),
    'linux-armv7': entry('printbetter-0.3.0-linux-armv7.tar.gz', 'd', 14),
    'linux-armv6': entry('printbetter-0.3.0-linux-armv6.tar.gz', 'e', 15),
  },
}

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: Device[] = []
afterEach(() => {
  for (const d of sockets.splice(0)) d.close()
})

describe('GET /api/client/latest picks the artifact for the install', () => {
  let device: Agent
  beforeAll(async () => {
    await env.FILES.put('downloads/latest.json', JSON.stringify(MANIFEST))
    device = new Agent({ token: (await enrollDevice(owner)).token })
  })

  it('returns version, url, sha256 and size for each platform and install kind', async () => {
    const cases: [string, keyof typeof MANIFEST.files][] = [
      ['os=macos&arch=aarch64&kind=pkg', 'macos-pkg'],
      ['os=macos&arch=x86_64&kind=app', 'macos-universal'],
      ['os=macos&arch=aarch64', 'macos-universal'],
      ['os=linux&arch=x86_64&kind=pkg', 'linux-x86_64'],
      ['os=linux&arch=armv7', 'linux-armv7'],
      ['os=linux&arch=armv6', 'linux-armv6'],
    ]
    for (const [query, key] of cases) {
      const file = MANIFEST.files[key]
      const reply = await device.get(`/api/client/latest?${query}`)
      expect(reply.body, query).toEqual({ version: '0.3.0', url: `${ORIGIN}/dl/0.3.0/${file.name}`, sha256: file.sha256, size: file.size })
    }
  })

  it('rejects an unknown kind and 404s platforms the release lacks', async () => {
    const bad = await device.get('/api/client/latest?os=macos&arch=aarch64&kind=dmg')
    expect(bad.status).toBe(400)
    const missing = await device.get('/api/client/latest?os=linux&arch=aarch64')
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('no_build')
  })
})

describe('update command', () => {
  it('relays update to the device and returns where it is going', async () => {
    const ws = await freshWorkspace(owner)
    const s = await connectPrinter(owner, 'usb:04f9:0042:UPD1', ws)
    sockets.push(s.device)
    const pending = owner.agent.post(`/api/workspaces/${ws}/clients/${s.clientId}/commands`, { name: 'update' })
    const command = await s.device.next('command')
    expect(command).toMatchObject({ name: 'update', args: {} })
    s.device.send({ type: 'result', id: command.id, ok: true, data: { from: '0.1.0', to: '0.3.0' } })
    expect((await pending).body).toEqual({ ok: true, data: { from: '0.1.0', to: '0.3.0' } })
  })

  it('is refused for members', async () => {
    const ws = await freshWorkspace(owner)
    const s = await connectPrinter(owner, 'usb:04f9:0042:UPD2', ws)
    sockets.push(s.device)
    const member = await addMember(owner, 'member', ws)
    expect((await member.agent.post(`/api/workspaces/${ws}/clients/${s.clientId}/commands`, { name: 'update' })).status).toBe(403)
    expect(s.device.drain().filter((m) => m.type === 'command')).toEqual([])
  })
})

describe('autoUpdate setting', () => {
  it('defaults to on, and turning it off reaches the device', async () => {
    const ws = await freshWorkspace(owner)
    const s = await connectPrinter(owner, 'usb:04f9:0042:UPD3', ws)
    sockets.push(s.device)
    const path = `/api/workspaces/${ws}/clients/${s.clientId}`
    expect((await owner.agent.get(path)).body.settings.autoUpdate).toBe(true)
    const patched = await owner.agent.patch(path, { settings: { autoUpdate: false } })
    expect(patched.body.settings.autoUpdate).toBe(false)
    expect((await s.device.next('settings')).settings.autoUpdate).toBe(false)
    expect((await owner.agent.patch(path, { settings: { autoUpdate: 'yes' } })).status).toBe(400)
  })

  it('keeps the default for settings stored before the field existed', async () => {
    const ws = await freshWorkspace(owner)
    const { clientId } = await enrollDevice(owner, ws)
    await env.DB.prepare('UPDATE clients SET settings = ? WHERE id = ?').bind(JSON.stringify({ tray: false }), clientId).run()
    const client = (await owner.agent.get(`/api/workspaces/${ws}/clients/${clientId}`)).body
    expect(client.settings).toMatchObject({ tray: false, autoUpdate: true })
  })
})
