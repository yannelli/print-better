import type { PriceList, Prices } from '../../../shared/usage'
import type { Json } from '../../http/body'
import { badRequest, forbidden } from '../../http/errors'
import { isObj } from '../../http/validate'
import { all, stmt } from '../../lib/db'
import { requireScope } from '../../services/access'
import { audit } from '../../services/audit'
import type { Ctx } from '../../services/context'
import { notifyHub } from '../../services/hub'
import { memberAccess } from '../../services/permissions'
import { requireUsage } from './active'
import { isTimeZone } from './cycles'
import { loadUsageSettings, toPricesView } from './settings'
import { onlyKeys, priceList } from './values'

const UPDATE_KEYS = ['currency', 'timeZone', 'default', 'printers']

/** `GET /prices`: members see the prices of the printers they can see. */
export async function getPrices(ctx: Ctx, workspaceId: string): Promise<Prices> {
  requireScope(ctx, 'read')
  const { access } = await memberAccess(ctx, workspaceId)
  await requireUsage(ctx, workspaceId)
  const prices = toPricesView(await loadUsageSettings(ctx.env, workspaceId))
  return { ...prices, printers: Object.fromEntries(Object.entries(prices.printers).filter(([id]) => access.can(id, 'view'))) }
}

function currencyOf(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (!Intl.supportedValuesOf('currency').includes(code)) throw badRequest('currency must be an ISO 4217 code, e.g. USD or EUR')
  return code
}

function timeZoneOf(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || !isTimeZone(name)) throw badRequest('timeZone must be an IANA time zone, e.g. America/Chicago')
  return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
}

/** Printer ids of this workspace to their own prices, or null to go back to the default. */
async function printerPrices(env: Env, workspaceId: string, value: unknown): Promise<[string, PriceList | null][]> {
  if (!isObj(value)) throw badRequest('printers must be an object of printer ids to price lists or null')
  const entries = Object.entries(value).map(([id, list]): [string, PriceList | null] => [id, list === null ? null : priceList(list, `printers.${id}`)])
  const ids = entries.map(([id]) => id)
  const known = new Set(
    (await all<{ id: string }>(env.DB, 'SELECT id FROM printers WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))', workspaceId, JSON.stringify(ids))).map(
      (r) => r.id,
    ),
  )
  const missing = ids.filter((id) => !known.has(id))
  if (missing.length > 0) throw badRequest(`Printer not found: ${missing.join(', ')}`)
  return entries
}

/** `PUT /prices`: omitted fields stay. Admins only. */
export async function setPrices(ctx: Ctx, workspaceId: string, body: Json): Promise<Prices> {
  requireScope(ctx, 'write')
  const { role } = await memberAccess(ctx, workspaceId)
  await requireUsage(ctx, workspaceId)
  if (role === 'member') throw forbidden('Only admins can change prices')
  onlyKeys(body, UPDATE_KEYS, 'field')
  const current = await loadUsageSettings(ctx.env, workspaceId)
  const currency = body.currency === undefined ? current.currency : currencyOf(body.currency)
  const timeZone = body.timeZone === undefined ? current.timeZone : timeZoneOf(body.timeZone)
  const prices = body.default === undefined ? current.prices : priceList(body.default, 'default')
  const printers = body.printers === undefined ? [] : await printerPrices(ctx.env, workspaceId, body.printers)
  const now = Date.now()
  const db = ctx.env.DB
  await db.batch([
    stmt(
      db,
      `INSERT INTO usage_settings (workspace_id, currency, time_zone, bw_page_micros, color_page_micros, duplex_sheet_discount_micros, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET currency = excluded.currency, time_zone = excluded.time_zone, bw_page_micros = excluded.bw_page_micros,
         color_page_micros = excluded.color_page_micros, duplex_sheet_discount_micros = excluded.duplex_sheet_discount_micros, updated_at = excluded.updated_at`,
      workspaceId,
      currency,
      timeZone,
      prices.bwPageMicros,
      prices.colorPageMicros,
      prices.duplexSheetDiscountMicros,
      now,
    ),
    ...printers.map(([id, list]) =>
      list
        ? stmt(
            db,
            `INSERT INTO printer_prices (printer_id, workspace_id, bw_page_micros, color_page_micros, duplex_sheet_discount_micros, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (printer_id) DO UPDATE SET bw_page_micros = excluded.bw_page_micros, color_page_micros = excluded.color_page_micros,
               duplex_sheet_discount_micros = excluded.duplex_sheet_discount_micros, updated_at = excluded.updated_at`,
            id,
            workspaceId,
            list.bwPageMicros,
            list.colorPageMicros,
            list.duplexSheetDiscountMicros,
            now,
          )
        : stmt(db, 'DELETE FROM printer_prices WHERE printer_id = ? AND workspace_id = ?', id, workspaceId),
    ),
  ])
  await audit(ctx, workspaceId, 'prices.update', workspaceId, { fields: Object.keys(body), printers: printers.length ? printers.map(([id]) => id) : undefined })
  notifyHub(ctx, workspaceId, (hub) => hub.broadcast([{ type: 'usage' }]))
  return toPricesView(await loadUsageSettings(ctx.env, workspaceId))
}
