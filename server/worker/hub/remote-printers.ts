import type { RemotePrinter } from '../../shared/protocol'
import { PRINTER_VIEW, toPrinter } from '../db/map'
import type { PrinterViewRow } from '../db/rows'
import { sha256Hex } from '../lib/crypto'
import { all } from '../lib/db'

export interface RemoteSnapshot {
  printers: RemotePrinter[]
  /** Compared with the last one sent to a socket, so unchanged snapshots are never re-sent. */
  fingerprint: string
}

function toRemote(row: PrinterViewRow): RemotePrinter {
  const p = toPrinter(row)
  return {
    id: p.id,
    name: p.name,
    location: p.location,
    makeModel: p.makeModel,
    uuid: p.uuid,
    clientName: p.clientName,
    online: p.clientOnline && p.status.state !== 'offline',
    state: p.status.state,
    capabilities: p.capabilities,
    defaults: p.defaults,
  }
}

/** Per receiving device: every added printer in the workspace that it does not own or see itself. */
export async function remoteSnapshots(env: Env, workspaceId: string, receivers: Iterable<string>): Promise<Map<string, RemoteSnapshot>> {
  const rows = await all<PrinterViewRow>(env.DB, `${PRINTER_VIEW} WHERE p.workspace_id = ? AND p.added = 1 ORDER BY p.name COLLATE NOCASE, p.id`, workspaceId)
  const owned = rows.map((row) => ({ clientId: row.client_id, key: row.key, printer: toRemote(row) }))
  const seen = await all<{ client_id: string; key: string; uuid: string | null }>(env.DB, 'SELECT client_id, key, uuid FROM printers WHERE workspace_id = ?', workspaceId)
  const out = new Map<string, RemoteSnapshot>()
  for (const clientId of new Set(receivers)) {
    // A printer this device already found itself would show up twice in its print dialog.
    const mine = seen.filter((s) => s.client_id === clientId)
    const keys = new Set(mine.map((s) => s.key))
    const uuids = new Set(mine.flatMap((s) => (s.uuid ? [s.uuid] : [])))
    const printers = owned
      .filter((o) => o.clientId !== clientId && !keys.has(o.key) && !(o.printer.uuid && uuids.has(o.printer.uuid)))
      .map((o) => o.printer)
    out.set(clientId, { printers, fingerprint: await sha256Hex(JSON.stringify(printers)) })
  }
  return out
}
