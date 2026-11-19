import type { Capabilities, DocType, JobOptions, JobUsage } from '../../../shared/printing'
import type { PriceList } from '../../../shared/usage'
import { EMPTY_CAPABILITIES } from '../../db/map'
import type { PrinterViewRow } from '../../db/rows'
import { parseJson } from '../../lib/db'

/** What usage needs to know about a printer. */
export interface PrinterFacts {
  capabilities: Capabilities
  defaults: JobOptions
}

export const printerFacts = (row: Pick<PrinterViewRow, 'capabilities' | 'defaults'>): PrinterFacts => ({
  capabilities: { ...EMPTY_CAPABILITIES, ...parseJson<Partial<Capabilities>>(row.capabilities, {}) },
  defaults: parseJson<JobOptions>(row.defaults, {}),
})

/** The job's own options over the printer's defaults, as the device applies them. */
export const effectiveOptions = (printer: PrinterFacts, options: JobOptions): JobOptions => ({ ...printer.defaults, ...options })

/** It asks for color, or for automatic on a color printer. */
export function printsInColor(printer: PrinterFacts, options: JobOptions): boolean {
  const mode = effectiveOptions(printer, options).colorMode ?? 'auto'
  return mode === 'color' || (mode === 'auto' && printer.capabilities.color)
}

export const asksTwoSided = (printer: PrinterFacts, options: JobOptions): boolean => (effectiveOptions(printer, options).sides ?? 'one-sided') !== 'one-sided'

/** A printer without duplex prints a two-sided request on one side. */
export const printsTwoSided = (printer: PrinterFacts, options: JobOptions): boolean => asksTwoSided(printer, options) && printer.capabilities.duplex

export const copiesOf = (printer: PrinterFacts, options: JobOptions): number => effectiveOptions(printer, options).copies ?? 1

/** A document that couldn't be counted: 1 page per 3,000 bytes of text or 20,000 bytes of anything else, leaning towards more. */
export const pagesFromSize = (size: number, contentType: DocType): number => Math.max(1, Math.ceil(size / (contentType === 'text/plain' ? 3_000 : 20_000)))

/** Distinct pages of a `documentPages`-page document within `pageRanges` ("1-3,5"); a document not counted yet is one page. */
export function selectedPages(pageRanges: string | undefined, documentPages: number | null): number {
  if (documentPages === null) return 1
  if (!pageRanges) return documentPages
  const ranges = pageRanges
    .split(',')
    .map((part) => part.split('-').map(Number))
    .map(([from, to = from]) => [Math.max(1, from), Math.min(to, documentPages)])
    .filter(([from, to]) => from <= to)
    .sort((a, b) => a[0] - b[0])
  let count = 0
  let reached = 0
  for (const [from, to] of ranges) {
    if (to <= reached) continue
    count += to - Math.max(from, reached + 1) + 1
    reached = to
  }
  return count
}

export interface PageShape {
  color: boolean
  twoSided: boolean
}

/** Sheets and cost for `pages` printed sides; `perCopy` rounds two-sided sheets up per copy. */
export function costOf(pages: number, shape: PageShape, prices: PriceList, perCopy = { selected: pages, copies: 1 }) {
  const sheets = shape.twoSided ? Math.ceil(perCopy.selected / 2) * perCopy.copies : pages
  const duplexSheets = shape.twoSided ? Math.floor(perCopy.selected / 2) * perCopy.copies : 0
  const colorPages = shape.color ? pages : 0
  const gross = colorPages * prices.colorPageMicros + (pages - colorPages) * prices.bwPageMicros
  return { sheets, colorPages, costMicros: Math.max(0, gross - duplexSheets * prices.duplexSheetDiscountMicros) }
}

/** The usage of one attempt before it prints. */
export function estimateUsage(printer: PrinterFacts, options: JobOptions, documentPages: number | null, prices: PriceList): JobUsage {
  const selected = selectedPages(effectiveOptions(printer, options).pageRanges, documentPages)
  const copies = copiesOf(printer, options)
  const pages = selected * copies
  const shape = { color: printsInColor(printer, options), twoSided: printsTwoSided(printer, options) }
  return { documentPages, pages, ...costOf(pages, shape, prices, { selected, copies }), estimated: true }
}
