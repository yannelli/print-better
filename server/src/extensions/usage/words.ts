import type { PriceList, UsageMeter } from '@shared/usage'
import { formatAmount, formatMicros } from '@shared/usage-text'

/** Typed money to micros; null unless it is a plain amount with at most 6 decimals. */
export function parseMoney(text: string): number | null {
  const plain = text.trim().replace(',', '.')
  return /^\d{1,9}(\.\d{0,6})?$/.test(plain) ? Math.round(Number(plain) * 1_000_000) : null
}

export const moneyText = (micros: number): string => String(micros / 1_000_000)

const DAY = 86_400_000

/** "today", "this month" and so on, from a cycle's length: cycles run from one local midnight to another. */
export function cycleWord(m: Pick<UsageMeter, 'start' | 'end'>): string {
  const days = (m.end - m.start) / DAY
  if (days < 1.5) return 'today'
  if (days < 8) return 'this week'
  if (days < 32) return 'this month'
  if (days < 93) return 'this quarter'
  return 'this year'
}

/** The day a cycle starts over, in the workspace time zone, e.g. "Dec 1". */
export const resetDay = (end: number, timeZone: string): string => new Date(end).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone })

/** "84 of 500 pages left this month, resets Dec 1". */
export function meterLine(m: UsageMeter, currency: string, timeZone: string): string {
  const left = Math.max(0, m.left)
  const amounts = m.unit === 'cost' ? `${formatMicros(left, currency)} of ${formatMicros(m.amount, currency)}` : `${left.toLocaleString()} of ${formatAmount(m.unit, m.amount, currency)}`
  return `${amounts} left ${cycleWord(m)}, resets ${resetDay(m.end, timeZone)}`
}

/** The meter closest to running out, or one this job goes over. */
export function tightest<M extends UsageMeter & { over?: boolean }>(meters: readonly M[]): M | undefined {
  const share = (m: M) => (m.over ? -1 : m.amount > 0 ? m.left / m.amount : 0)
  return [...meters].sort((a, b) => share(a) - share(b))[0]
}

export type PriceText = Record<keyof PriceList, string>

export const PRICE_FIELDS: { key: keyof PriceList; label: string; description: string }[] = [
  { key: 'bwPageMicros', label: 'Black-and-white page', description: 'Each side printed in black and white, for each copy.' },
  { key: 'colorPageMicros', label: 'Color page', description: 'Each side printed in color, for each copy.' },
  { key: 'duplexSheetDiscountMicros', label: 'Two-sided discount', description: 'Taken off for each sheet printed on both sides.' },
]

export const priceText = (list: PriceList): PriceText => ({
  bwPageMicros: moneyText(list.bwPageMicros),
  colorPageMicros: moneyText(list.colorPageMicros),
  duplexSheetDiscountMicros: moneyText(list.duplexSheetDiscountMicros),
})

/** The typed prices, or null while any of them isn't a valid amount. */
export function parsePrices(text: PriceText): PriceList | null {
  const [bw, color, discount] = PRICE_FIELDS.map((f) => parseMoney(text[f.key]))
  return bw === null || color === null || discount === null ? null : { bwPageMicros: bw, colorPageMicros: color, duplexSheetDiscountMicros: discount }
}

export const priceSummary = (list: PriceList, currency: string): string =>
  `${formatMicros(list.bwPageMicros, currency)} black and white, ${formatMicros(list.colorPageMicros, currency)} color, ` +
  `${formatMicros(list.duplexSheetDiscountMicros, currency)} off each two-sided sheet`
