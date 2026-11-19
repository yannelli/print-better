import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { PrinterConfig } from '../shared/protocol'
import { Device, eventually, printerReport } from './helpers/device'
import { freshWorkspace } from './helpers/jobs'
import { enrollDevice, setupOwner, type Owner } from './helpers/world'

let owner: Owner
beforeAll(async () => {
  owner = await setupOwner()
})

const sockets: Device[] = []
afterEach(() => {
  for (const d of sockets.splice(0)) d.close()
})

async function readyDevice(ws: string): Promise<{ device: Device; clientId: string }> {
  const { clientId, token } = await enrollDevice(owner, ws)
  const device = await Device.connect(token)
  sockets.push(device)
  await device.hello()
  return { device, clientId }
}

const network = (key: string) => printerReport(key, { local: false, routes: [{ kind: 'ipps', uri: `ipps://${key}.local/ipp/print` }] })
const added = (configs: PrinterConfig[]) => Object.fromEntries(configs.map((p) => [p.key, p.added]))
const printer = async (ws: string, id: string) => (await owner.agent.get(`/api/workspaces/${ws}/printers/${id}`)).body

describe('printer snapshots', () => {
  it('smart policy adds attached printers and up to three network printers', async () => {
    const { device } = await readyDevice(await freshWorkspace(owner))
    const config = await device.report([printerReport('usb:1'), network('n1'), network('n2'), network('n3')])
    expect(added(config.printers)).toEqual({ 'usb:1': true, n1: true, n2: true, n3: true })
  })

  it('smart policy leaves network printers for one-click adding when the device sees more than three', async () => {
    const { device } = await readyDevice(await freshWorkspace(owner))
    const config = await device.report([printerReport('usb:1'), network('n1'), network('n2'), network('n3'), network('n4')])
    expect(added(config.printers)).toEqual({ 'usb:1': true, n1: false, n2: false, n3: false, n4: false })
  })

  it('follows the workspace policy unless the device overrides it', async () => {
    const ws = await freshWorkspace(owner)
    expect((await owner.agent.patch(`/api/workspaces/${ws}`, { settings: { autoAdd: 'none' } })).status).toBe(200)
    const inherit = await readyDevice(ws)
    expect(added((await inherit.device.report([printerReport('usb:1')])).printers)).toEqual({ 'usb:1': false })

    const custom = await readyDevice(ws)
    await owner.agent.patch(`/api/workspaces/${ws}/clients/${custom.clientId}`, { settings: { autoAdd: 'all' } })
    await custom.device.next('settings')
    const config = await custom.device.report(['a', 'b', 'c', 'd', 'e'].map(network))
    expect(Object.values(added(config.printers))).toEqual([true, true, true, true, true])
  })

  it('does not auto-add a printer (same uuid) another device already added', async () => {
    const ws = await freshWorkspace(owner)
    const shared = { uuid: 'urn:uuid:1b4e28ba-2fa1-11d2-883f-0016d3cca427' }
    const first = await readyDevice(ws)
    expect(added((await first.device.report([printerReport('usb:a', shared)])).printers)).toEqual({ 'usb:a': true })
    const second = await readyDevice(ws)
    expect(added((await second.device.report([printerReport('os:Brother', shared)])).printers)).toEqual({ 'os:Brother': false })
  })

  it('keeps printers missing from a snapshot, marks them offline, and leaves user names alone', async () => {
    const ws = await freshWorkspace(owner)
    const { device } = await readyDevice(ws)
    const config = await device.report([printerReport('usb:a'), printerReport('usb:b')])
    const b = config.printers.find((p) => p.key === 'usb:b')?.id as string
    expect((await owner.agent.patch(`/api/workspaces/${ws}/printers/${b}`, { name: 'Front desk' })).status).toBe(200)
    await device.next('printer_config')

    await device.report([printerReport('usb:a')])
    expect(await printer(ws, b)).toMatchObject({ name: 'Front desk', added: true, status: { state: 'offline' } })

    await device.report([printerReport('usb:a'), printerReport('usb:b', { name: 'Renamed by the device' })])
    expect(await printer(ws, b)).toMatchObject({ name: 'Front desk', status: { state: 'idle' } })
  })

  it('drops malformed reports and sanitizes the rest', async () => {
    const ws = await freshWorkspace(owner)
    const { device } = await readyDevice(ws)
    const messy = {
      ...printerReport('usb:ok'),
      routes: [{ kind: 'ftp', uri: 'ftp://x' }, { kind: 'usb', uri: 'usb://Brother/HL?serial=1' }],
      status: { state: 'exploded', reasons: ['media-empty', 7], message: null, supplies: [{ name: 'Black', kind: 'toner', level: 250 }] },
    }
    const config = await device.report([{ key: '' } as never, { name: 'no key' } as never, messy as never])
    expect(config.printers.map((p) => p.key)).toEqual(['usb:ok'])
    const row = await printer(ws, config.printers[0].id)
    expect(row.routes).toEqual([{ kind: 'usb', uri: 'usb://Brother/HL?serial=1' }])
    expect(row.status).toEqual({ state: 'unknown', reasons: ['media-empty'], message: null, supplies: [{ name: 'Black', kind: 'toner', color: null, level: -1 }] })
  })
})

describe('printer status', () => {
  it('applies printer_status reports and ignores unknown keys', async () => {
    const ws = await freshWorkspace(owner)
    const { device } = await readyDevice(ws)
    const config = await device.report([printerReport('usb:a')])
    const id = config.printers[0].id
    device.send({ type: 'printer_status', key: 'usb:unknown', status: { state: 'stopped', reasons: [], message: null, supplies: [] } })
    device.send({
      type: 'printer_status',
      key: 'usb:a',
      status: { state: 'stopped', reasons: ['media-empty'], message: 'Load paper', supplies: [{ name: 'Black', kind: 'toner', color: '#000000', level: 12 }] },
    })
    await eventually(async () =>
      expect((await printer(ws, id)).status).toEqual({ state: 'stopped', reasons: ['media-empty'], message: 'Load paper', supplies: [{ name: 'Black', kind: 'toner', color: '#000000', level: 12 }] }),
    )
    expect(device.closed).toBeNull()
  })

  it('tells the device which printers to serve after a user edits one', async () => {
    const ws = await freshWorkspace(owner)
    const { device } = await readyDevice(ws)
    const config = await device.report([network('n1'), network('n2'), network('n3'), network('n4')])
    const id = config.printers.find((p) => p.key === 'n2')?.id as string
    await owner.agent.patch(`/api/workspaces/${ws}/printers/${id}`, { added: true, name: 'Upstairs', defaults: { copies: 2 } })
    const pushed = await device.next('printer_config')
    expect(pushed.printers.find((p) => p.key === 'n2')).toMatchObject({ id, added: true, name: 'Upstairs', defaults: { copies: 2 } })
  })
})
