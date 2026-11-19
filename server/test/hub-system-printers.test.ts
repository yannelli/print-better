import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Client, SystemPrinters } from '../shared/types'
import { connectPrinter, Device, eventually, printerReport } from './helpers/device'
import { EventSocket, freshWorkspace } from './helpers/jobs'
import { enrollDevice, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: { close(): void }[] = []
afterEach(() => {
  for (const s of sockets.splice(0)) s.close()
})

async function desk(ws: string): Promise<{ device: Device; clientId: string }> {
  const { clientId, token } = await enrollDevice(owner, ws)
  const device = await Device.connect(token)
  sockets.push(device)
  await device.hello({ os: 'macos' })
  return { device, clientId }
}

const clientOf = async (ws: string, id: string): Promise<Client> => {
  const res = await owner.agent.get(`/api/workspaces/${ws}/clients`)
  const list = (Array.isArray(res.body) ? res.body : res.body.items) as Client[]
  return list.find((c) => c.id === id)!
}

const REPORT: SystemPrinters = {
  active: true,
  error: null,
  printers: [
    { id: 'pr_1', state: 'added', queue: 'pb_pr_1', installed: 'Office_Laser', installedName: 'Office laser', direct: true },
    { id: 'pr_2', state: 'hidden', queue: null, installed: null, installedName: null, direct: false },
  ],
  defaultQueue: 'pb_pr_1',
  defaultName: 'Front desk laser',
  defaultPrinterId: 'pr_1',
  defaultProblem: null,
  lastUsed: true,
}

describe('system_printers', () => {
  it('is null until a device reports it, then stored and sent to browsers once per change', async () => {
    const ws = await freshWorkspace(owner)
    const d = await desk(ws)
    expect((await clientOf(ws, d.clientId)).systemPrinters).toBeNull()
    const ui = await EventSocket.open(owner.agent, ws)
    sockets.push(ui)

    d.device.send({ type: 'system_printers', report: REPORT })
    const event = await ui.next('client', (e) => e.client.id === d.clientId && e.client.systemPrinters !== null)
    expect(event.client.systemPrinters).toEqual(REPORT)
    expect((await clientOf(ws, d.clientId)).systemPrinters).toEqual(REPORT)

    d.device.send({ type: 'system_printers', report: REPORT })
    d.device.send({ type: 'system_printers', report: { ...REPORT, defaultProblem: 'waiting' } })
    const next = await ui.next('client', (e) => e.client.id === d.clientId)
    expect(next.client.systemPrinters?.defaultProblem).toBe('waiting')
  })

  it('drops malformed parts of a report and caps its text', async () => {
    const ws = await freshWorkspace(owner)
    const d = await desk(ws)
    const printers = [{ id: 'pr_1', state: 'direct', queue: 'x' }, { id: '', state: 'added' }, { id: 'pr_3', state: 'hidden', queue: 7, installed: 'q'.repeat(200), installedName: 5, direct: 'yes' }]
    const report = { active: 'yes', error: 'e'.repeat(900), printers, defaultName: 'n'.repeat(200), defaultProblem: 'odd', lastUsed: 1 }
    d.device.send({ type: 'system_printers', report })
    const stored = await eventually(async () => {
      const report = (await clientOf(ws, d.clientId)).systemPrinters
      expect(report).not.toBeNull()
      return report!
    })
    expect(stored).toEqual({
      active: false,
      error: 'e'.repeat(500),
      printers: [{ id: 'pr_3', state: 'hidden', queue: null, installed: 'q'.repeat(127), installedName: null, direct: false }],
      defaultQueue: null,
      defaultName: 'n'.repeat(127),
      defaultPrinterId: null,
      defaultProblem: null,
      lastUsed: false,
    })
  })
})

describe('remote_printers direct list', () => {
  it('flags printers the receiver reports itself without leaving them out', async () => {
    const ws = await freshWorkspace(owner)
    const uuid = '7d3b9a1e-2c4f-4e8a-9b6d-1f0e5c2a8b34'
    const s = await connectPrinter(owner, `uuid:${uuid}`, ws)
    sockets.push(s.device)
    await s.device.report([printerReport(`uuid:${uuid}`, { uuid })])
    const d = await desk(ws)
    expect((await d.device.next('remote_printers')).direct).toBeUndefined()
    await d.device.report([printerReport('net:printer.local:631', { uuid, local: false })])
    const msg = await d.device.next('remote_printers')
    expect(msg.printers.map((p) => p.id)).toEqual([s.printerId])
    expect(msg.direct).toEqual([{ id: s.printerId, uuid }])
  })
})

describe('printer choices in device settings', () => {
  it('validates, dedupes, and pushes hidden printers and the default printer', async () => {
    const ws = await freshWorkspace(owner)
    const d = await desk(ws)
    const path = `/api/workspaces/${ws}/clients/${d.clientId}`
    expect((await clientOf(ws, d.clientId)).settings).toMatchObject({ remotePrintersHidden: [], defaultPrinter: null })

    const patched = await owner.agent.patch(path, { settings: { remotePrintersHidden: ['pr_1', 'pr_1', 'pr_2'], defaultPrinter: 'pr_3' } })
    expect(patched.body.settings).toMatchObject({ remotePrintersHidden: ['pr_1', 'pr_2'], defaultPrinter: 'pr_3' })
    expect((await d.device.next('settings')).settings).toMatchObject({ remotePrintersHidden: ['pr_1', 'pr_2'], defaultPrinter: 'pr_3' })

    expect((await owner.agent.patch(path, { settings: { defaultPrinter: null } })).body.settings.defaultPrinter).toBeNull()
    expect((await owner.agent.patch(path, { settings: { remotePrintersHidden: 'pr_1' } })).status).toBe(400)
    expect((await owner.agent.patch(path, { settings: { remotePrintersHidden: [1] } })).status).toBe(400)
    expect((await owner.agent.patch(path, { settings: { defaultPrinter: 'x'.repeat(65) } })).status).toBe(400)
  })

  it('keeps them when a device that does not know them sends its settings', async () => {
    const ws = await freshWorkspace(owner)
    const d = await desk(ws)
    const path = `/api/workspaces/${ws}/clients/${d.clientId}`
    await owner.agent.patch(path, { settings: { remotePrintersHidden: ['pr_1'], defaultPrinter: 'pr_2' } })
    const old = { tray: false, lanSharing: false, autoAdd: 'inherit', discovery: { mdns: true, snmp: true, usb: true, os: true }, paused: false, logLevel: 'info' }
    await new Promise((r) => setTimeout(r, 20))
    d.device.send({ type: 'settings', settings: old, updatedAt: Date.now() })
    const settings = await eventually(async () => {
      const current = (await clientOf(ws, d.clientId)).settings
      expect(current.tray).toBe(false)
      return current
    })
    expect(settings).toMatchObject({ remotePrintersHidden: ['pr_1'], defaultPrinter: 'pr_2' })
  })
})
