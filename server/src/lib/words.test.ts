import { describe, expect, it } from 'vitest'
import {
  type Client,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_PRINTER_SETTINGS,
  type Printer,
  type PrinterState,
  type SystemPrinter,
  type SystemPrinterState,
} from '@shared/types'
import {
  clientStatus,
  defaultPrinterProblem,
  deviceKind,
  jobOrigin,
  jobStatus,
  printerProblems,
  printerStatus,
  reasonWords,
  systemPrinterStatus,
} from './words'

function printer(state: PrinterState, reasons: string[] = [], extra: Partial<Printer> = {}): Printer {
  return {
    id: 'p1',
    workspaceId: 'w',
    clientId: 'c1',
    clientName: 'Kitchen Mac',
    clientOnline: true,
    added: true,
    defaults: {},
    settings: DEFAULT_PRINTER_SETTINGS,
    createdAt: 0,
    updatedAt: 0,
    key: 'k',
    name: 'Printer',
    makeModel: null,
    uuid: null,
    location: null,
    local: false,
    routes: [],
    capabilities: { formats: [], color: false, duplex: false, media: [], mediaDefault: null, resolutions: [], copiesMax: 1 },
    status: { state, reasons, message: null, supplies: [] },
    ...extra,
  }
}

describe('printerStatus', () => {
  it('reports the computer being off before anything the printer said', () => {
    const s = printerStatus(printer('idle', ['media-jam'], { clientOnline: false }))
    expect(s).toEqual({ label: 'Offline', tone: 'neutral', detail: 'Kitchen Mac is turned off or not connected' })
  })

  it('is Ready when idle, mentioning low supplies without alarming', () => {
    expect(printerStatus(printer('idle'))).toEqual({ label: 'Ready', tone: 'ok', detail: undefined })
    expect(printerStatus(printer('idle', ['toner-low', 'media-low']))).toMatchObject({
      label: 'Ready',
      tone: 'ok',
      detail: 'Toner is low, Paper is running low',
    })
  })

  it('puts a blocking problem first in plain words', () => {
    expect(printerStatus(printer('stopped', ['media-empty']))).toMatchObject({ label: 'Out of paper', tone: 'warn' })
    expect(printerStatus(printer('stopped', ['toner-low', 'cover-open', 'media-jam']))).toMatchObject({ label: 'Paper jam', tone: 'bad' })
  })

  it('keeps showing Printing for minor issues, but not for errors', () => {
    expect(printerStatus(printer('printing', ['media-needed']))).toMatchObject({ label: 'Printing', tone: 'info' })
    expect(printerStatus(printer('printing', ['media-jam']))).toMatchObject({ label: 'Paper jam', tone: 'bad' })
  })

  it('covers the remaining states', () => {
    expect(printerStatus(printer('stopped'))).toMatchObject({ label: 'Needs attention', tone: 'warn' })
    expect(printerStatus(printer('offline'))).toMatchObject({ label: 'Not responding', tone: 'bad' })
    expect(printerStatus(printer('unknown'))).toEqual({ label: 'Checking', tone: 'neutral' })
  })

  it('passes the printer message through as detail', () => {
    const p = printer('stopped', ['media-empty'])
    p.status.message = 'Load letter paper in tray 1'
    expect(printerStatus(p).detail).toBe('Load letter paper in tray 1')
  })
})

describe('reasons', () => {
  it('turns unknown keywords into readable words', () => {
    expect(reasonWords('media-empty')).toEqual(['Out of paper', 'warn'])
    expect(reasonWords('interpreter-resource-unavailable')).toEqual(['Interpreter resource unavailable', 'warn'])
  })

  it('ignores none/other and sorts worst first', () => {
    const problems = printerProblems(printer('stopped', ['none', 'toner-low', 'other', 'media-jam', 'door-open']))
    expect(problems.map((p) => p.text)).toEqual(['Paper jam', 'Toner is low', 'A door is open'])
    expect(problems.map((p) => p.minor)).toEqual([false, true, false])
  })
})

describe('jobStatus', () => {
  it('uses plain words and carries the message', () => {
    expect(jobStatus({ status: 'failed', statusMessage: null })).toEqual({ label: "Didn't print", tone: 'bad' })
    expect(jobStatus({ status: 'dispatched', statusMessage: 'Waiting: out of paper' })).toEqual({
      label: 'Sending to printer',
      tone: 'info',
      detail: 'Waiting: out of paper',
    })
    expect(jobStatus({ status: 'completed', statusMessage: null }).label).toBe('Printed')
  })
})

describe('devices', () => {
  const client = (extra: Partial<Client>): Client => ({
    id: 'c',
    workspaceId: 'w',
    name: 'Mac',
    hostname: null,
    os: 'macos',
    arch: 'aarch64',
    version: null,
    online: true,
    lastSeenAt: null,
    settings: DEFAULT_CLIENT_SETTINGS,
    settingsUpdatedAt: 0,
    systemPrinters: null,
    createdAt: 0,
    ...extra,
  })

  it('reports online, paused and offline', () => {
    expect(clientStatus(client({})).label).toBe('Online')
    expect(clientStatus(client({ settings: { ...DEFAULT_CLIENT_SETTINGS, paused: true } }))).toMatchObject({ label: 'Paused', tone: 'warn' })
    expect(clientStatus(client({ online: false, settings: { ...DEFAULT_CLIENT_SETTINGS, paused: true } })).label).toBe('Offline')
  })

  it('names the kind of device', () => {
    expect(deviceKind({ os: 'macos', arch: 'aarch64' })).toBe('Mac')
    expect(deviceKind({ os: 'windows', arch: 'x86_64' })).toBe('Windows PC')
    expect(deviceKind({ os: 'linux', arch: 'x86_64' })).toBe('Linux computer')
    expect(deviceKind({ os: 'linux', arch: 'armv7' })).toBe('Raspberry Pi or Linux')
    expect(deviceKind({ os: 'linux', arch: 'aarch64' })).toBe('Raspberry Pi or Linux')
    expect(deviceKind({ os: null, arch: null })).toBe('Device')
  })
})

describe('jobOrigin', () => {
  const job = { sourceClientName: null, requestedBy: null }

  it('names the source for jobs from the website, email and the like', () => {
    expect(jobOrigin({ ...job, source: 'web' })).toBe('From website')
    expect(jobOrigin({ ...job, source: 'email' })).toBe('From email')
  })

  it('names the computer and the person for jobs from a print dialog', () => {
    expect(jobOrigin({ source: 'device', sourceClientName: 'Kitchen Mac', requestedBy: 'sam' })).toBe('From Kitchen Mac (sam)')
    expect(jobOrigin({ source: 'device', sourceClientName: 'Kitchen Mac', requestedBy: null })).toBe('From Kitchen Mac')
    expect(jobOrigin({ ...job, source: 'device', requestedBy: 'sam' })).toBe('From a removed device (sam)')
  })
})

describe('systemPrinterStatus', () => {
  const at = (state: SystemPrinterState, extra: Partial<SystemPrinter> = {}) => ({ state, queue: null, installed: null, direct: false, ...extra })

  it('says how a printer shows up on a desktop', () => {
    expect(systemPrinterStatus(at('added', { queue: 'pb_pr_1' }), 'this Mac')).toEqual({ label: 'Added', tone: 'ok', detail: 'System printer pb_pr_1' })
    expect(systemPrinterStatus(at('hidden'), 'this computer')).toMatchObject({ label: 'Hidden', detail: "Print Better doesn't add it to this computer" })
    expect(systemPrinterStatus(at('error'), 'this Mac').tone).toBe('bad')
    expect(systemPrinterStatus(undefined, 'this Mac')).toMatchObject({ label: 'Adding', tone: 'neutral' })
  })

  it('mentions a copy installed directly, or that the computer finds it itself', () => {
    expect(systemPrinterStatus(at('added', { queue: 'pb_pr_1', installed: 'Office_Laser', direct: true }), 'this Mac').detail).toBe(
      'System printer pb_pr_1. Also installed directly as Office_Laser',
    )
    expect(systemPrinterStatus(at('hidden', { direct: true }), 'this Mac').detail).toBe("Print Better doesn't add it to this Mac. This Mac also finds it on its network")
  })
})

describe('defaultPrinterProblem', () => {
  it('explains each problem in the computer’s own terms', () => {
    expect(defaultPrinterProblem('hidden', 'Laser', { os: 'macos' })).toBe("Laser is hidden on this Mac, so it can't be the default.")
    expect(defaultPrinterProblem('waiting', 'Laser', { os: 'linux' })).toBe("Laser becomes the default once it's added to this computer.")
    expect(defaultPrinterProblem('failed', 'Laser', { os: 'linux' })).toBe("This computer couldn't change its default printer.")
  })
})
