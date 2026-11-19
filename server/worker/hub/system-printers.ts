import type { DefaultPrinterProblem, SystemPrinter, SystemPrinterState, SystemPrinters } from '../../shared/types'
import { toClient } from '../db/map'
import type { ClientRow } from '../db/rows'
import { isObj } from '../http/validate'
import { first } from '../lib/db'
import type { Session } from './client-messages'

const STATES: SystemPrinterState[] = ['added', 'hidden', 'waiting', 'error']
const PROBLEMS: DefaultPrinterProblem[] = ['hidden', 'waiting', 'unavailable', 'failed']

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null)

function sanitizePrinter(v: unknown): SystemPrinter | null {
  if (!isObj(v) || typeof v.id !== 'string' || v.id === '' || v.id.length > 64) return null
  if (!STATES.includes(v.state as SystemPrinterState)) return null
  return { id: v.id, state: v.state as SystemPrinterState, queue: text(v.queue, 127), installed: text(v.installed, 127), direct: v.direct === true }
}

/** Device reports are only loosely trusted: anything malformed is dropped, text is capped. */
export function sanitizeSystemPrinters(v: unknown): SystemPrinters | null {
  if (!isObj(v)) return null
  const printers = Array.isArray(v.printers) ? v.printers.slice(0, 500).map(sanitizePrinter) : []
  return {
    active: v.active === true,
    error: text(v.error, 500),
    printers: printers.filter((p): p is SystemPrinter => p !== null),
    defaultQueue: text(v.defaultQueue, 127),
    defaultPrinterId: text(v.defaultPrinterId, 64),
    defaultProblem: PROBLEMS.includes(v.defaultProblem as DefaultPrinterProblem) ? (v.defaultProblem as DefaultPrinterProblem) : null,
    lastUsed: v.lastUsed === true,
  }
}

/** Stores the report on the device row and tells browsers when it changed. */
export async function onSystemPrinters(s: Session, report: unknown): Promise<void> {
  const clean = sanitizeSystemPrinters(report)
  if (!clean) return
  const json = JSON.stringify(clean)
  const row = await first<ClientRow>(
    s.env.DB,
    'UPDATE clients SET system_printers = ? WHERE id = ? AND system_printers IS NOT ? RETURNING *',
    json,
    s.att.clientId,
    json,
  )
  if (row) s.broadcast([{ type: 'client', client: toClient(row) }])
}
