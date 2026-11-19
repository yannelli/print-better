import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { RemotePrintersMsg, ServerMessage } from '../shared/protocol'
import { DEFAULT_CLIENT_SETTINGS } from '../shared/types'
import { connectPrinter, Device, eventually, printerReport, type Station } from './helpers/device'
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

/** A paired desktop with no printers of its own, connected and past `welcome`. */
async function desk(ws: string): Promise<{ device: Device; clientId: string; token: string }> {
  const { clientId, token } = await enrollDevice(owner, ws)
  const device = await Device.connect(token)
  sockets.push(device)
  await device.hello({ os: 'macos' })
  return { device, clientId, token }
}

async function station(ws: string, key = 'usb:04f9:0042:A1B2'): Promise<Station> {
  const s = await connectPrinter(owner, key, ws)
  sockets.push(s.device)
  return s
}

const snapshot = async (device: Device): Promise<RemotePrintersMsg['printers']> => (await device.next('remote_printers')).printers
const names = (printers: RemotePrintersMsg['printers']) => printers.map((p) => p.name)

/** Hub messages are async: give any (wrong) snapshot time to arrive, then check none did. */
async function noSnapshot(device: Device, ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
  expect(device.drain().filter((m) => m.type === 'remote_printers')).toEqual([])
}

async function uiSocket(ws: string): Promise<EventSocket> {
  const ui = await EventSocket.open(owner.agent, ws)
  sockets.push(ui)
  return ui
}

describe('remote_printers', () => {
  it('follows welcome with every added printer on other devices, on every new connection', async () => {
    const ws = await freshWorkspace(owner)
    const s = await station(ws)
    const { token } = await enrollDevice(owner, ws)
    const device = await Device.connect(token)
    sockets.push(device)
    device.send({ type: 'hello', protocol: 1, version: '0.1.0', os: 'macos', arch: 'arm64', hostname: 'kitchen-mac', features: [], settings: DEFAULT_CLIENT_SETTINGS, settingsUpdatedAt: 0 })
    const seen: ServerMessage[] = []
    await eventually(async () => {
      seen.push(...device.drain())
      expect(seen.map((m) => m.type)).toContain('remote_printers')
    })
    expect(seen.map((m) => m.type)).toEqual(['welcome', 'remote_printers'])
    const printers = (seen[1] as RemotePrintersMsg).printers
    expect(printers).toEqual([
      {
        id: s.printerId,
        name: 'Printer usb:04f9:0042:A1B2',
        location: null,
        makeModel: 'Brother HL-L2350DW',
        uuid: null,
        clientName: 'office-pi',
        online: true,
        state: 'idle',
        capabilities: expect.objectContaining({ duplex: true, media: ['na_letter_8.5x11in'] }),
        defaults: {},
      },
    ])

    device.close()
    const again = await Device.connect(token)
    sockets.push(again)
    await again.hello()
    expect(await snapshot(again)).toEqual(printers)
  })

  it('leaves out the receiver’s own printers and printers not added', async () => {
    const ws = await freshWorkspace(owner)
    const s = await station(ws)
    expect(await snapshot(s.device)).toEqual([])
    await s.device.report([printerReport(s.printerKey), printerReport('usb:second')])
    await noSnapshot(s.device)

    const d = await desk(ws)
    expect(names(await snapshot(d.device))).toEqual(['Printer usb:04f9:0042:A1B2', 'Printer usb:second'])
    await owner.agent.patch(`/api/workspaces/${ws}/printers/${s.printerId}`, { added: false })
    expect(names(await snapshot(d.device))).toEqual(['Printer usb:second'])
    await noSnapshot(s.device)
  })

  it('leaves out printers the receiver can already reach itself, matched by key or uuid', async () => {
    const ws = await freshWorkspace(owner)
    const uuid = '7d3b9a1e-2c4f-4e8a-9b6d-1f0e5c2a8b34'
    const s = await station(ws, `uuid:${uuid}`)
    await s.device.report([printerReport(`uuid:${uuid}`, { uuid }), printerReport('usb:other')])
    const d = await desk(ws)
    expect((await snapshot(d.device)).map((p) => [p.name, p.uuid])).toEqual([['Printer usb:other', null], [`Printer uuid:${uuid}`, uuid]])
    await d.device.report([printerReport('net:printer.local:631', { uuid, local: false })])
    expect(names(await snapshot(d.device))).toEqual(['Printer usb:other'])
  })

  it('sends a new snapshot when a printer is renamed, edited, or removed', async () => {
    const ws = await freshWorkspace(owner)
    const s = await station(ws)
    const d = await desk(ws)
    await snapshot(d.device)
    await owner.agent.patch(`/api/workspaces/${ws}/printers/${s.printerId}`, { name: 'Front desk', location: 'Hallway' })
    expect(await snapshot(d.device)).toMatchObject([{ name: 'Front desk', location: 'Hallway' }])
    await owner.agent.patch(`/api/workspaces/${ws}/printers/${s.printerId}`, { defaults: { sides: 'two-sided-long-edge' } })
    expect(await snapshot(d.device)).toMatchObject([{ defaults: { sides: 'two-sided-long-edge' } }])
    await owner.agent.del(`/api/workspaces/${ws}/printers/${s.printerId}`)
    expect(await snapshot(d.device)).toEqual([])
  })

  it('reports printer state changes but not polls that change nothing it carries', async () => {
    const ws = await freshWorkspace(owner)
    const s = await station(ws)
    const d = await desk(ws)
    await snapshot(d.device)
    const ui = await uiSocket(ws)
    const status = (state: string, reasons: string[] = []) => ({ state, reasons, message: null, supplies: [] })

    s.device.send({ type: 'printer_status', key: s.printerKey, status: status('idle') })
    await ui.next('printer')
    await noSnapshot(d.device)
    s.device.send({ type: 'printer_status', key: s.printerKey, status: status('idle', ['toner-low']) })
    await ui.next('printer')
    await noSnapshot(d.device)

    s.device.send({ type: 'printer_status', key: s.printerKey, status: status('stopped', ['media-empty']) })
    expect(await snapshot(d.device)).toMatchObject([{ state: 'stopped', online: true }])
    s.device.send({ type: 'printer_status', key: s.printerKey, status: status('offline') })
    expect(await snapshot(d.device)).toMatchObject([{ state: 'offline', online: false }])
  })

  it('marks printers offline while their device is away and back when it returns', async () => {
    const ws = await freshWorkspace(owner)
    const s = await station(ws)
    const d = await desk(ws)
    await snapshot(d.device)
    s.device.close()
    expect(await snapshot(d.device)).toMatchObject([{ id: s.printerId, online: false, state: 'idle' }])
    const back = await Device.connect(s.token)
    sockets.push(back)
    await back.hello()
    expect(await snapshot(d.device)).toMatchObject([{ id: s.printerId, online: true }])
  })

  it('does not resend for changes that leave a device’s snapshot alone', async () => {
    const ws = await freshWorkspace(owner)
    await station(ws)
    const d = await desk(ws)
    await snapshot(d.device)
    await owner.agent.patch(`/api/workspaces/${ws}/clients/${d.clientId}`, { settings: { remotePrinters: false } })
    expect((await d.device.next('settings')).settings.remotePrinters).toBe(false)
    await noSnapshot(d.device)
    const other = await desk(ws)
    expect(names(await snapshot(other.device))).toEqual(['Printer usb:04f9:0042:A1B2'])
    await noSnapshot(d.device)
  })

  it('includes printers a desktop reports itself for everyone else', async () => {
    const ws = await freshWorkspace(owner)
    const s = await station(ws)
    const d = await desk(ws)
    await snapshot(d.device)
    await snapshot(s.device)
    await d.device.report([printerReport('usb:desk-printer', { name: 'Desk inkjet' })])
    expect(names(await snapshot(s.device))).toEqual(['Desk inkjet'])
    await noSnapshot(d.device)
  })
})
