import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkspaceHub } from '../worker/hub/hub'
import { connectPrinter, Device, type Station } from './helpers/device'
import { freshWorkspace } from './helpers/jobs'
import { addMember, enrollDevice, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: Device[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of sockets.splice(0)) d.close()
})

async function station(): Promise<Station & { ws: string }> {
  const ws = await freshWorkspace(owner)
  const s = await connectPrinter(owner, 'usb:04f9:0042:A1B2', ws)
  sockets.push(s.device)
  return { ...s, ws }
}

const commandsPath = (s: { ws: string; clientId: string }) => `/api/workspaces/${s.ws}/clients/${s.clientId}/commands`

describe('device commands', () => {
  it('relays a command and returns the device result', async () => {
    const s = await station()
    const pending = owner.agent.post(commandsPath(s), { name: 'diagnose' })
    const command = await s.device.next('command')
    expect(command).toMatchObject({ name: 'diagnose', args: {} })
    const checks = [{ name: 'server', ok: true, detail: 'reachable' }]
    s.device.send({ type: 'result', id: command.id, ok: true, data: { checks } })
    const r = await pending
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, data: { checks } })
  })

  it('passes device errors through and passes arguments to the device', async () => {
    const s = await station()
    const pending = owner.agent.post(commandsPath(s), { name: 'logs', args: { lines: 50 } })
    const command = await s.device.next('command')
    expect(command.args).toEqual({ lines: 50 })
    s.device.send({ type: 'result', id: 'someone-else', ok: true })
    s.device.send({ type: 'result', id: command.id, ok: false, error: 'Log file missing' })
    expect((await pending).body).toEqual({ ok: false, error: 'Log file missing' })
  })

  it('relays identify and refresh for a printer with its key', async () => {
    const s = await station()
    for (const name of ['identify', 'refresh'] as const) {
      const pending = owner.agent.post(`/api/workspaces/${s.ws}/printers/${s.printerId}/${name}`)
      const command = await s.device.next('command')
      expect(command).toMatchObject({ name, args: { key: s.printerKey } })
      s.device.send({ type: 'result', id: command.id, ok: true, data: name === 'refresh' ? { count: 1 } : {} })
      expect((await pending).body.ok).toBe(true)
    }
  })

  it('reports a timeout when the device does not answer within 20 s', async () => {
    const s = await station()
    // Fake timers must fire inside the hub's I/O context; firing them from the test context is a cross-object I/O error.
    const outcome = await runInDurableObject(env.HUB.getByName(s.ws), async (hub: WorkspaceHub) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        let settled = false
        const pending = hub.command(s.ws, s.clientId, 'discover', {}).finally(() => (settled = true))
        await vi.advanceTimersByTimeAsync(19_999)
        const early = settled
        await vi.advanceTimersByTimeAsync(1)
        return { early, result: await pending }
      } finally {
        vi.useRealTimers()
      }
    })
    expect(outcome).toEqual({ early: false, result: { ok: false, error: 'timeout' } })
    expect((await s.device.next('command')).name).toBe('discover')
  })

  it('answers 409 client_offline for devices that are not connected or not past hello', async () => {
    const ws = await freshWorkspace(owner)
    const never = await enrollDevice(owner, ws)
    const offline = await owner.agent.post(commandsPath({ ws, clientId: never.clientId }), { name: 'discover' })
    expect(offline.status).toBe(409)
    expect(offline.body.error.code).toBe('client_offline')

    const pre = await enrollDevice(owner, ws)
    sockets.push(await Device.connect(pre.token))
    expect((await owner.agent.post(commandsPath({ ws, clientId: pre.clientId }), { name: 'discover' })).body.error.code).toBe('client_offline')
  })

  it('accepts only the documented commands and only from admins', async () => {
    const s = await station()
    for (const name of ['unpair', 'format-disk']) {
      const r = await owner.agent.post(commandsPath(s), { name })
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe('invalid_request')
    }
    const member = await addMember(owner, 'member', s.ws)
    expect((await member.agent.post(commandsPath(s), { name: 'discover' })).status).toBe(403)
    expect(s.device.drain().filter((m) => m.type === 'command')).toEqual([])
  })
})
