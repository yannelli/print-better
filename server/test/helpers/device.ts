import type { PrinterReport } from '../../shared/printing'
import type { ClientMessage, PrinterConfigMsg, ServerMessage, WelcomeMsg } from '../../shared/protocol'
import { DEFAULT_CLIENT_SETTINGS } from '../../shared/types'
import { call } from './http'
import { enrollDevice, type Owner } from './world'

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>

/** A paired device's WebSocket to the hub, with an inbox the test reads from. */
export class Device {
  private inbox: ServerMessage[] = []
  private wakers = new Set<() => void>()
  closed: { code: number; reason: string } | null = null

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data === 'pong') return
      this.inbox.push(JSON.parse(e.data) as ServerMessage)
      this.wake()
    })
    ws.addEventListener('close', (e) => {
      this.closed = { code: e.code, reason: e.reason }
      this.wake()
    })
    ws.accept()
  }

  static async connect(token: string, headers: Record<string, string> = {}): Promise<Device> {
    const res = await call('/api/client/ws', { headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}`, 'X-PB-Protocol': '1', ...headers } })
    if (!res.webSocket) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`)
    return new Device(res.webSocket)
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg))
  }

  /** The oldest unread message of `type` (waiting for one if needed); other messages stay queued. */
  async next<T extends ServerMessage['type']>(type: T, timeoutMs = 3000): Promise<Of<T>> {
    let found: Of<T> | undefined
    await this.until(() => {
      const i = this.inbox.findIndex((m) => m.type === type)
      if (i >= 0) found = this.inbox.splice(i, 1)[0] as Of<T>
      return found !== undefined
    }, timeoutMs, `no "${type}" message`)
    return found as Of<T>
  }

  /** Everything received and not yet read. */
  drain(): ServerMessage[] {
    const all = this.inbox
    this.inbox = []
    return all
  }

  async waitClosed(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    await this.until(() => this.closed !== null, timeoutMs, 'socket stayed open')
    return this.closed as { code: number; reason: string }
  }

  async hello(overrides: Record<string, unknown> = {}): Promise<WelcomeMsg> {
    this.send({ type: 'hello', protocol: 1, version: '0.1.0', os: 'linux', arch: 'aarch64', hostname: 'office-pi', features: [], settings: DEFAULT_CLIENT_SETTINGS, settingsUpdatedAt: 0, ...overrides })
    return this.next('welcome')
  }

  async report(printers: PrinterReport[]): Promise<PrinterConfigMsg> {
    this.send({ type: 'printers', printers })
    return this.next('printer_config')
  }

  close(code = 1000): void {
    try {
      this.ws.close(code, 'test done')
    } catch {
      // Already closed.
    }
  }

  private until(ready: () => boolean, timeoutMs: number, failure: string): Promise<void> {
    if (ready()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waker = () => {
        if (!ready()) return
        clearTimeout(timer)
        this.wakers.delete(waker)
        resolve()
      }
      const timer = setTimeout(() => {
        this.wakers.delete(waker)
        reject(new Error(`${failure} within ${timeoutMs} ms`))
      }, timeoutMs)
      this.wakers.add(waker)
    })
  }

  private wake(): void {
    for (const waker of [...this.wakers]) waker()
  }
}

export function printerReport(key: string, over: Partial<PrinterReport> = {}): PrinterReport {
  return {
    key,
    name: `Printer ${key}`,
    makeModel: 'Brother HL-L2350DW',
    uuid: null,
    location: null,
    local: true,
    routes: [{ kind: 'ipp', uri: 'ipp://192.168.1.20/ipp/print' }],
    capabilities: { formats: ['application/pdf'], color: false, duplex: true, media: ['na_letter_8.5x11in'], mediaDefault: 'na_letter_8.5x11in', resolutions: [600], copiesMax: 99 },
    status: { state: 'idle', reasons: [], message: null, supplies: [] },
    ...over,
  }
}

/** Retries `check` until it stops throwing; hub messages are processed asynchronously. */
export async function eventually<T>(check: () => Promise<T>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await check()
    } catch (e) {
      if (Date.now() > deadline) throw e
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}

export interface Station {
  device: Device
  clientId: string
  token: string
  printerId: string
  printerKey: string
}

/** Pairs and connects a device that reports one USB printer, auto-added by the default "smart" policy. */
export async function connectPrinter(owner: Owner, key = 'usb:04f9:0042:A1B2', workspaceId = owner.workspaceId): Promise<Station> {
  const { clientId, token } = await enrollDevice(owner, workspaceId)
  const device = await Device.connect(token)
  await device.hello()
  const config = await device.report([printerReport(key)])
  const printer = config.printers.find((p) => p.key === key)
  if (!printer?.added) throw new Error(`printer ${key} was not auto-added`)
  return { device, clientId, token, printerId: printer.id, printerKey: key }
}
