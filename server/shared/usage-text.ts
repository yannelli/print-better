import type { UsageUnit } from './usage'

const UNIT_WORDS: Record<Exclude<UsageUnit, 'cost'>, [string, string]> = { pages: ['page', 'pages'], sheets: ['sheet', 'sheets'], jobs: ['job', 'jobs'] }

/** Micros (millionths) of `currency` as money; prices below a cent keep their digits, e.g. "$0.025". */
export function formatMicros(micros: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 6 }).format(micros / 1_000_000)
}

/** An amount of a limit's unit, e.g. "1 page", "84 sheets", "$3.50". */
export function formatAmount(unit: UsageUnit, value: number, currency: string, locale?: string): string {
  if (unit === 'cost') return formatMicros(value, currency, locale)
  const [one, many] = UNIT_WORDS[unit]
  return `${value.toLocaleString(locale)} ${value === 1 ? one : many}`
}
