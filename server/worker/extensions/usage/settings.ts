import { DEFAULT_CURRENCY, DEFAULT_PRICES, DEFAULT_TIME_ZONE, type PriceList, type Prices } from '../../../shared/usage'
import { stmt } from '../../lib/db'
import { memo, type Ctx } from '../../services/context'

/** A workspace's currency, time zone and prices; defaults until an admin saves them. */
export interface UsageSettings {
  currency: string
  timeZone: string
  prices: PriceList
  printers: ReadonlyMap<string, PriceList>
}

interface PriceRow {
  bw_page_micros: number
  color_page_micros: number
  duplex_sheet_discount_micros: number
}

const toPrices = (r: PriceRow): PriceList => ({
  bwPageMicros: r.bw_page_micros,
  colorPageMicros: r.color_page_micros,
  duplexSheetDiscountMicros: r.duplex_sheet_discount_micros,
})

export async function loadUsageSettings(env: Env, workspaceId: string): Promise<UsageSettings> {
  const [settings, printers] = await env.DB.batch([
    stmt(env.DB, 'SELECT * FROM usage_settings WHERE workspace_id = ?', workspaceId),
    stmt(env.DB, 'SELECT * FROM printer_prices WHERE workspace_id = ?', workspaceId),
  ])
  const row = settings.results[0] as (PriceRow & { currency: string; time_zone: string }) | undefined
  return {
    currency: row?.currency ?? DEFAULT_CURRENCY,
    timeZone: row?.time_zone ?? DEFAULT_TIME_ZONE,
    prices: row ? toPrices(row) : DEFAULT_PRICES,
    printers: new Map((printers.results as (PriceRow & { printer_id: string })[]).map((p) => [p.printer_id, toPrices(p)])),
  }
}

/** Loaded once per request. */
export const usageSettings = (ctx: Ctx, workspaceId: string): Promise<UsageSettings> =>
  memo(ctx, `usage-settings:${workspaceId}`, () => loadUsageSettings(ctx.env, workspaceId))

export const pricesFor = (s: UsageSettings, printerId: string | null): PriceList => (printerId ? s.printers.get(printerId) : undefined) ?? s.prices

export const toPricesView = (s: UsageSettings): Prices => ({
  currency: s.currency,
  timeZone: s.timeZone,
  default: s.prices,
  printers: Object.fromEntries(s.printers),
})
