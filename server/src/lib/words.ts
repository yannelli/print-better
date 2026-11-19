// Plain-language wording for printer, job and device states. Keep the UI's vocabulary here.
import type { Client, DefaultPrinterProblem, Job, JobStatus, Printer, Sides, SystemPrinter, SystemPrinters } from '@shared/types'

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral'

export interface StatusWords {
  label: string
  tone: Tone
  detail?: string
}

const REASONS: Record<string, [string, Tone]> = {
  'media-empty': ['Out of paper', 'warn'],
  'media-needed': ['Load paper', 'warn'],
  'media-low': ['Paper is running low', 'warn'],
  'media-jam': ['Paper jam', 'bad'],
  'media-path-jam': ['Paper jam', 'bad'],
  'toner-empty': ['Out of toner', 'bad'],
  'toner-low': ['Toner is low', 'warn'],
  'marker-supply-empty': ['Out of ink or toner', 'bad'],
  'marker-supply-low': ['Ink or toner is low', 'warn'],
  'marker-waste-full': ['Waste box is full', 'bad'],
  'marker-waste-almost-full': ['Waste box is almost full', 'warn'],
  'door-open': ['A door is open', 'warn'],
  'cover-open': ['The cover is open', 'warn'],
  'input-tray-missing': ['Paper tray is missing', 'warn'],
  'output-tray-missing': ['Output tray is missing', 'warn'],
  'output-area-full': ['Output tray is full', 'warn'],
  'output-area-almost-full': ['Output tray is almost full', 'warn'],
  'developer-low': ['Developer is low', 'warn'],
  'opc-near-eol': ['Drum needs replacing soon', 'warn'],
  'opc-life-over': ['Drum needs replacing', 'bad'],
  'fuser-over-temp': ['Printer is too hot', 'bad'],
  'spool-area-full': ['Printer memory is full', 'bad'],
  'paused': ['Paused', 'warn'],
  'moving-to-paused': ['Pausing', 'warn'],
  'shutdown': ['Turned off', 'neutral'],
  'offline-report': ['Turned off or unplugged', 'neutral'],
  'connecting-to-device': ['Connecting', 'info'],
  'timed-out': ['Not answering', 'bad'],
  'cups-missing-filter': ['Missing a printer driver', 'bad'],
}

const IGNORED = new Set(['none', 'other'])
const RANK: Record<Tone, number> = { bad: 4, warn: 3, info: 2, neutral: 1, ok: 0 }

export function reasonWords(reason: string): [string, Tone] {
  const known = REASONS[reason]
  if (known) return known
  const text = reason.replace(/-/g, ' ')
  return [text.charAt(0).toUpperCase() + text.slice(1), 'warn']
}

export interface Problem {
  text: string
  tone: Tone
  /** Low supplies and similar warnings that do not stop printing. */
  minor: boolean
}

/** Every problem the printer reports, worst first. */
export function printerProblems(printer: Printer): Problem[] {
  return printer.status.reasons
    .filter((r) => !IGNORED.has(r))
    .map((r) => {
      const [text, tone] = reasonWords(r)
      return { text, tone, minor: /-low$|almost-full|near-eol/.test(r) }
    })
    .sort((a, b) => RANK[b.tone] - RANK[a.tone])
}

export function printerStatus(printer: Printer): StatusWords {
  if (!printer.clientOnline) {
    return { label: 'Offline', tone: 'neutral', detail: `${printer.clientName} is turned off or not connected` }
  }
  const problems = printerProblems(printer)
  const blocking = problems.find((p) => !p.minor)
  if (blocking && (blocking.tone === 'bad' || printer.status.state !== 'printing')) {
    return { label: blocking.text, tone: blocking.tone, detail: printer.status.message ?? undefined }
  }
  const minor = problems.filter((p) => p.minor).map((p) => p.text).join(', ') || undefined
  switch (printer.status.state) {
    case 'idle':
      return { label: 'Ready', tone: 'ok', detail: minor }
    case 'printing':
      return { label: 'Printing', tone: 'info', detail: printer.status.message ?? minor }
    case 'stopped':
      return { label: 'Needs attention', tone: 'warn', detail: printer.status.message ?? minor }
    case 'offline':
      return { label: 'Not responding', tone: 'bad', detail: 'Check that the printer is on and connected' }
    default:
      return { label: 'Checking', tone: 'neutral' }
  }
}

const JOB: Record<JobStatus, StatusWords> = {
  uploading: { label: 'Uploading', tone: 'info' },
  queued: { label: 'Waiting', tone: 'neutral' },
  dispatched: { label: 'Sending to printer', tone: 'info' },
  printing: { label: 'Printing', tone: 'info' },
  completed: { label: 'Printed', tone: 'ok' },
  failed: { label: "Didn't print", tone: 'bad' },
  canceled: { label: 'Canceled', tone: 'neutral' },
}

export function jobStatus(job: Pick<Job, 'status' | 'statusMessage'>): StatusWords {
  const base = JOB[job.status]
  return job.statusMessage ? { ...base, detail: job.statusMessage } : base
}

export const JOB_STATUS_LABELS = JOB

export function clientStatus(client: Client): StatusWords {
  if (!client.online) return { label: 'Offline', tone: 'neutral' }
  if (client.settings.paused) return { label: 'Paused', tone: 'warn', detail: 'Holding print jobs until you resume' }
  return { label: 'Online', tone: 'ok' }
}

export const OS_NAMES = { macos: 'Mac', windows: 'Windows PC', linux: 'Linux computer' } as const

export function deviceKind(client: Pick<Client, 'os' | 'arch'>): string {
  if (!client.os) return 'Device'
  if (client.os === 'linux' && client.arch && /^(arm|aarch64)/.test(client.arch)) return 'Raspberry Pi or Linux'
  return OS_NAMES[client.os]
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** "this Mac" or "this computer", for sentences about a desktop. */
export const thisComputer = (client: Pick<Client, 'os'>) => (client.os === 'macos' ? 'this Mac' : 'this computer')

/** Where a desktop's own printers are set up, for "Add it in …" instructions. */
export const printerSettingsPlace = (client: Pick<Client, 'os'>) =>
  client.os === 'macos' ? 'System Settings > Printers & Scanners' : "this computer's printer settings"

/** How a workspace printer shows up on a desktop, from the device's report (undefined: not reported yet). */
export function systemPrinterStatus(printer: Omit<SystemPrinter, 'id'> | undefined, name: string, where: string): StatusWords {
  const also = printer?.installed
    ? `Also installed directly as “${printer.installedName ?? printer.installed.replaceAll('_', ' ')}”`
    : printer?.direct
      ? `${capitalized(where)} also finds it on its network`
      : null
  const words = (label: string, tone: Tone, detail: string): StatusWords => ({ label, tone, detail: also ? `${detail}. ${also}` : detail })
  switch (printer?.state) {
    case 'added':
      return words('Added', 'ok', `In the print window as “${name}”`)
    case 'hidden':
      return words('Hidden', 'neutral', `Print Better doesn't add it to ${where}`)
    case 'error':
      return words("Couldn't add", 'bad', 'See the problem above')
    default:
      return words('Adding', 'neutral', `Being added to ${where}`)
  }
}

/** A desktop's default printer as its print window names it (`printer`: the workspace printer behind it). */
export function defaultPrinterName(report: SystemPrinters, printer: Pick<Printer, 'name'> | undefined): string | null {
  const queue = report.defaultQueue
  if (!queue) return null
  const ours = queue.startsWith('pb_')
  const name = (ours ? printer?.name : undefined) ?? report.defaultName ?? printer?.name ?? queue.replaceAll('_', ' ')
  return ours ? `${name} (Print Better)` : name
}

/** Why the chosen default printer is not the default yet. */
export function defaultPrinterProblem(problem: DefaultPrinterProblem, name: string, client: Pick<Client, 'os'>): string {
  const where = thisComputer(client)
  switch (problem) {
    case 'hidden':
      return `${name} is hidden on ${where}, so it can't be the default.`
    case 'waiting':
      return `${name} becomes the default once it's added to ${where}.`
    case 'unavailable':
      return `${name} isn't offered to ${where} right now.`
    case 'failed':
      return `${capitalized(where)} couldn't change its default printer.`
  }
}

export const SIDES: Record<Sides, string> = {
  'one-sided': 'One side',
  'two-sided-long-edge': 'Both sides, like a book',
  'two-sided-short-edge': 'Both sides, flip up',
}

export const SOURCES: Record<Job['source'], string> = {
  web: 'Website',
  api: 'API',
  mcp: 'AI assistant',
  email: 'Email',
  lan: 'Local network',
  test: 'Test page',
  device: 'Device',
}

/** Where a job came from, e.g. "From website" or "From Kitchen Mac (sam)" for one printed from a computer's print dialog. */
export function jobOrigin(job: Pick<Job, 'source' | 'sourceClientName' | 'requestedBy'>): string {
  if (job.source !== 'device') return `From ${SOURCES[job.source].toLowerCase()}`
  const device = job.sourceClientName ?? 'a removed device'
  return job.requestedBy ? `From ${device} (${job.requestedBy})` : `From ${device}`
}

export const ROLE_NAMES = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const
export const ROLE_HELP = {
  owner: 'Full control, including deleting the workspace',
  admin: 'Manage printers, devices, members and settings',
  member: 'Print, and manage their own print jobs',
} as const
