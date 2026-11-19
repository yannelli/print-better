import { PROTOCOL_VERSION, type HelloMsg, type JobStatusMsg, type LanJobMsg, type ResultMsg, type ServerMessage, type UiEvent } from '../../shared/protocol'
import type { Os } from '../../shared/types'
import { clientSettings, toClient, toJob, toPrinter } from '../db/map'
import type { ClientRow, JobViewRow } from '../db/rows'
import { jobsEnded } from '../extensions/finish'
import { first } from '../lib/db'
import { deviceSettings } from '../services/client-settings'
import { systemCtx } from '../services/context'
import { isTerminal } from '../services/jobs'
import { alertIfNeeded } from './alerts'
import { applySnapshot, applyPrinterStatus, printerConfigs } from './inventory'
import { applyJobStatus, applyLanJob, pendingOffers } from './jobs'
import type { ClientAtt } from './sockets'
import { onSystemPrinters } from './system-printers'

export interface Session {
  env: Env
  ws: WebSocket
  att: ClientAtt
  save(): void
  send(msg: ServerMessage): void
  broadcast(events: UiEvent[]): void
  resolveCommand(msg: ResultMsg): void
  /** Resolves once this socket (and every other ready one) has its current `remote_printers`. */
  syncRemotePrinters(): Promise<void>
  waitUntil(p: Promise<unknown>): void
}

const OS: Os[] = ['macos', 'windows', 'linux']
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null)

const loadClient = (s: Session) => first<ClientRow>(s.env.DB, 'SELECT * FROM clients WHERE id = ?', s.att.clientId)

/** Device settings are last-write-wins on updatedAt; future timestamps are clamped so a skewed clock cannot pin them. */
function settingsWinner(row: ClientRow, reported: unknown, reportedAt: unknown) {
  const incoming = deviceSettings(clientSettings(row.settings), reported)
  const at = typeof reportedAt === 'number' ? Math.min(reportedAt, Date.now()) : -1
  return incoming && at > row.settings_updated_at ? { settings: incoming, updatedAt: at } : null
}

async function onHello(s: Session, msg: HelloMsg): Promise<void> {
  if (msg.protocol !== PROTOCOL_VERSION) {
    s.ws.close(4400, `Unsupported protocol ${String(msg.protocol)}`)
    return
  }
  const client = await loadClient(s)
  if (!client) {
    s.ws.close(4401, 'Device removed')
    return
  }
  const won = settingsWinner(client, msg.settings, msg.settingsUpdatedAt)
  const now = Date.now()
  const row = await first<ClientRow>(
    s.env.DB,
    `UPDATE clients SET hostname = ?, os = ?, arch = ?, version = ?, features = ?, settings = ?, settings_updated_at = ?, online = 1, last_seen_at = ?
     WHERE id = ? RETURNING *`,
    text(msg.hostname, 253) ?? client.hostname,
    OS.includes(msg.os) ? msg.os : client.os,
    text(msg.arch, 32) ?? client.arch,
    text(msg.version, 32) ?? client.version,
    JSON.stringify(Array.isArray(msg.features) ? msg.features.filter((f) => typeof f === 'string').slice(0, 32) : []),
    won ? JSON.stringify(won.settings) : client.settings,
    won ? won.updatedAt : client.settings_updated_at,
    now,
    client.id,
  )
  if (!row) return
  s.att.ready = true
  s.att.remotePrinters = undefined
  s.save()
  s.send({
    type: 'welcome',
    clientId: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    settings: clientSettings(row.settings),
    settingsUpdatedAt: row.settings_updated_at,
    serverTime: now,
    printers: await printerConfigs(s.env, row.id),
  })
  await s.syncRemotePrinters()
  for (const job of await pendingOffers(s.env, row.workspace_id, row.id)) s.send({ type: 'job', job })
  s.broadcast([{ type: 'client', client: toClient(row) }])
}

async function onPrinters(s: Session, printers: unknown): Promise<void> {
  const client = await loadClient(s)
  if (!client) return
  const rows = await applySnapshot(s.env, client, printers)
  s.send({ type: 'printer_config', printers: await printerConfigs(s.env, client.id) })
  s.broadcast(rows.map((p) => ({ type: 'printer', printer: toPrinter(p) })))
}

async function onSettings(s: Session, settings: unknown, updatedAt: unknown): Promise<void> {
  const client = await loadClient(s)
  if (!client) return
  const won = settingsWinner(client, settings, updatedAt)
  const row = won
    ? await first<ClientRow>(
        s.env.DB,
        'UPDATE clients SET settings = ?, settings_updated_at = ? WHERE id = ? AND settings_updated_at < ? RETURNING *',
        JSON.stringify(won.settings),
        won.updatedAt,
        client.id,
        won.updatedAt,
      )
    : null
  const current = row ?? client
  s.send({ type: 'settings', settings: clientSettings(current.settings), updatedAt: current.settings_updated_at })
  if (row) s.broadcast([{ type: 'client', client: toClient(row) }])
}

/** A report that ended its job runs the finish hooks first, so the event shows the settled usage. */
async function jobEvents(s: Session, job: JobViewRow): Promise<UiEvent[]> {
  if (!isTerminal(job.status)) return [{ type: 'job', job: toJob(job) }]
  const ended = await jobsEnded(systemCtx(s.env, s.att.origin, s.waitUntil), job.workspace_id, [job])
  return [{ type: 'job', job: toJob(ended.rows[0]) }, ...ended.events]
}

/** Anything but `hello` before the handshake is a protocol error (4400); unknown types are ignored for forward compatibility. */
export async function handleClientMessage(s: Session, msg: Record<string, unknown>): Promise<void> {
  if (!s.att.ready && msg.type !== 'hello') {
    s.ws.close(4400, 'Expected hello')
    return
  }
  switch (msg.type) {
    case 'hello':
      return onHello(s, msg as unknown as HelloMsg)
    case 'printers':
      return onPrinters(s, msg.printers)
    case 'printer_status': {
      const printer = await applyPrinterStatus(s.env, s.att.clientId, msg.key, msg.status)
      if (!printer) return
      const view = toPrinter(printer)
      s.broadcast([{ type: 'printer', printer: view }])
      s.waitUntil(alertIfNeeded(s.env, s.att.origin, printer, view.status).catch((e: unknown) => console.error('printer alert failed', e)))
      return
    }
    case 'job_status': {
      const outcome = await applyJobStatus(s.env, s.att.clientId, msg as unknown as JobStatusMsg)
      if (outcome.job) s.broadcast(await jobEvents(s, outcome.job))
      if (outcome.resendCancel && typeof msg.jobId === 'string') s.send({ type: 'cancel', jobId: msg.jobId })
      return
    }
    case 'lan_job': {
      const job = await applyLanJob(s.env, { id: s.att.clientId, workspace_id: s.att.workspaceId }, msg as unknown as LanJobMsg)
      if (job) s.broadcast([{ type: 'job', job: toJob(job) }])
      return
    }
    case 'result':
      if (typeof msg.id === 'string') s.resolveCommand(msg as unknown as ResultMsg)
      return
    case 'settings':
      return onSettings(s, msg.settings, msg.updatedAt)
    case 'system_printers':
      return onSystemPrinters(s, msg.report)
  }
}
