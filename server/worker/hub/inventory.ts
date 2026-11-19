import type { PrinterConfig } from '../../shared/protocol'
import type { Capabilities, PrinterReport, PrinterState, PrinterStatus, Route, RouteKind } from '../../shared/printing'
import { clientSettings, EMPTY_CAPABILITIES, PRINTER_VIEW, printerSettings, UNKNOWN_STATUS, workspaceSettings } from '../db/map'
import type { ClientRow, PrinterRow, PrinterViewRow } from '../db/rows'
import { isObj } from '../http/validate'
import { newId } from '../lib/crypto'
import { all, chunk, first, parseJson, stmt } from '../lib/db'

const STATES: PrinterState[] = ['idle', 'printing', 'stopped', 'offline', 'unknown']
const ROUTE_KINDS: RouteKind[] = ['ipps', 'ipp', 'socket', 'lpd', 'usb', 'os']
const SUPPLY_KINDS = ['toner', 'ink', 'drum', 'waste', 'other'] as const

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null)

export function sanitizeStatus(v: unknown): PrinterStatus | null {
  if (!isObj(v)) return null
  return {
    state: STATES.includes(v.state as PrinterState) ? (v.state as PrinterState) : 'unknown',
    reasons: Array.isArray(v.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string').slice(0, 32).map((r) => r.slice(0, 100)) : [],
    message: text(v.message, 500),
    supplies: Array.isArray(v.supplies)
      ? v.supplies.filter(isObj).slice(0, 32).map((s) => ({
          name: text(s.name, 100) ?? 'Supply',
          kind: SUPPLY_KINDS.includes(s.kind as (typeof SUPPLY_KINDS)[number]) ? (s.kind as (typeof SUPPLY_KINDS)[number]) : 'other',
          color: text(s.color, 32),
          level: typeof s.level === 'number' && s.level >= -1 && s.level <= 100 ? Math.round(s.level) : -1,
        }))
      : [],
  }
}

/** Device reports are only loosely trusted: anything oversized or malformed is dropped. */
function sanitizeReport(v: unknown): PrinterReport | null {
  if (!isObj(v) || typeof v.key !== 'string' || v.key === '' || v.key.length > 300) return null
  const caps = isObj(v.capabilities) && JSON.stringify(v.capabilities).length <= 65_536 ? (v.capabilities as Partial<Capabilities>) : {}
  return {
    key: v.key,
    name: text(v.name, 200) ?? v.key,
    makeModel: text(v.makeModel, 200),
    uuid: text(v.uuid, 100),
    location: text(v.location, 200),
    local: v.local === true,
    routes: Array.isArray(v.routes)
      ? v.routes
          .filter((r): r is Route => isObj(r) && ROUTE_KINDS.includes(r.kind as RouteKind) && typeof r.uri === 'string' && r.uri.length <= 500)
          .slice(0, 10)
          .map((r) => ({ kind: r.kind, uri: r.uri }))
      : [],
    capabilities: { ...EMPTY_CAPABILITIES, ...caps },
    status: sanitizeStatus(v.status) ?? UNKNOWN_STATUS,
  }
}

/** Replaces this device's inventory. Names and locations of known printers stay user-owned; missing ones go offline. */
export async function applySnapshot(env: Env, client: ClientRow, reports: unknown): Promise<PrinterViewRow[]> {
  const byKey = new Map<string, PrinterReport>()
  for (const r of Array.isArray(reports) ? reports.slice(0, 500) : []) {
    const report = sanitizeReport(r)
    if (report) byKey.set(report.key, report)
  }
  const existing = new Map((await all<PrinterRow>(env.DB, 'SELECT * FROM printers WHERE client_id = ?', client.id)).map((p) => [p.key, p]))
  const ws = await first<{ settings: string }>(env.DB, 'SELECT settings FROM workspaces WHERE id = ?', client.workspace_id)
  const own = clientSettings(client.settings).autoAdd
  const policy = own === 'inherit' ? workspaceSettings(ws?.settings ?? '{}').autoAdd : own
  const claimed = new Set(
    (
      await all<{ uuid: string }>(
        env.DB,
        'SELECT uuid FROM printers WHERE workspace_id = ? AND client_id != ? AND added = 1 AND uuid IS NOT NULL',
        client.workspace_id,
        client.id,
      )
    ).map((r) => r.uuid),
  )
  const networkCount = [...byKey.values()].filter((r) => !r.local).length
  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  for (const r of byKey.values()) {
    const old = existing.get(r.key)
    const json = [JSON.stringify(r.routes), JSON.stringify(r.capabilities), JSON.stringify(r.status)] as const
    if (old) {
      statements.push(
        stmt(env.DB, 'UPDATE printers SET make_model = ?, uuid = ?, local = ?, routes = ?, capabilities = ?, status = ?, updated_at = ? WHERE id = ?', r.makeModel, r.uuid, r.local, ...json, now, old.id),
      )
      continue
    }
    // smart: attached printers always; network printers only when the device sees few, so they are likely ours.
    const wanted = policy === 'all' || (policy === 'smart' && (r.local || networkCount <= 3))
    const added = wanted && !(r.uuid && claimed.has(r.uuid))
    statements.push(
      stmt(
        env.DB,
        `INSERT INTO printers (id, workspace_id, client_id, key, name, make_model, uuid, location, local, added, routes, capabilities, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        client.workspace_id,
        client.id,
        r.key,
        r.name,
        r.makeModel,
        r.uuid,
        r.location,
        r.local,
        added,
        ...json,
        now,
        now,
      ),
    )
  }
  for (const old of existing.values()) {
    if (byKey.has(old.key) || parseJson<PrinterStatus>(old.status, UNKNOWN_STATUS).state === 'offline') continue
    statements.push(stmt(env.DB, "UPDATE printers SET status = json_set(status, '$.state', 'offline'), updated_at = ? WHERE id = ?", now, old.id))
  }
  for (const part of chunk(statements, 50)) await env.DB.batch(part)
  return all<PrinterViewRow>(env.DB, `${PRINTER_VIEW} WHERE p.client_id = ? ORDER BY p.name`, client.id)
}

export async function applyPrinterStatus(env: Env, clientId: string, key: unknown, status: unknown): Promise<PrinterViewRow | null> {
  const s = sanitizeStatus(status)
  if (!s || typeof key !== 'string') return null
  const row = await first<{ id: string }>(
    env.DB,
    'UPDATE printers SET status = ?, updated_at = ? WHERE client_id = ? AND key = ? RETURNING id',
    JSON.stringify(s),
    Date.now(),
    clientId,
    key,
  )
  return row ? first<PrinterViewRow>(env.DB, `${PRINTER_VIEW} WHERE p.id = ?`, row.id) : null
}

export async function printerConfigs(env: Env, clientId: string): Promise<PrinterConfig[]> {
  const rows = await all<Pick<PrinterRow, 'id' | 'key' | 'name' | 'added' | 'settings' | 'defaults'>>(
    env.DB,
    'SELECT id, key, name, added, settings, defaults FROM printers WHERE client_id = ? ORDER BY name',
    clientId,
  )
  return rows.map((r) => ({
    key: r.key,
    id: r.id,
    name: r.name,
    added: r.added === 1,
    lanShare: printerSettings(r.settings).lanShare,
    defaults: parseJson(r.defaults, {}),
  }))
}
