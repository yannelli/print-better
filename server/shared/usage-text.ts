import type { JobUsage } from './printing'
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

/** What is left of an amount, e.g. "84 of 500 pages" or "$4.20 of $10.00"; never below zero. */
export function formatLeft(unit: UsageUnit, left: number, amount: number, currency: string, locale?: string): string {
  const shown = Math.max(0, left)
  if (unit === 'cost') return `${formatMicros(shown, currency, locale)} of ${formatMicros(amount, currency, locale)}`
  return `${shown.toLocaleString(locale)} of ${formatAmount(unit, amount, currency, locale)}`
}

/** How much of `unit` a job uses: every job is one job. */
export function amountOf(usage: JobUsage, unit: UsageUnit): number {
  return unit === 'pages' ? usage.pages : unit === 'sheets' ? usage.sheets : unit === 'jobs' ? 1 : usage.costMicros
}
