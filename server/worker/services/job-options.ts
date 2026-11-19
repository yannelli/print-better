import type { JobOptions } from '../../shared/printing'
import { badRequest } from '../http/errors'
import { isObj, optInt, optOneOf, optStr } from '../http/validate'

const PAGE_RANGES = { max: 100, pattern: /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/, hint: 'pageRanges must look like "1-3,5"' }

/** Validates a full JobOptions object; unknown keys are rejected so typos do not silently print wrong. */
export function parseJobOptions(value: unknown): JobOptions {
  if (!isObj(value)) throw badRequest('options must be an object')
  const known = ['copies', 'media', 'sides', 'colorMode', 'orientation', 'pageRanges', 'fit', 'quality']
  const unknown = Object.keys(value).filter((k) => !known.includes(k))
  if (unknown.length > 0) throw badRequest(`Unknown job option: ${unknown.join(', ')}`)
  const o: JobOptions = {
    copies: optInt(value, 'copies', 1, 999),
    media: optStr(value, 'media', { max: 100 }),
    sides: optOneOf(value, 'sides', ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'] as const),
    colorMode: optOneOf(value, 'colorMode', ['auto', 'color', 'monochrome'] as const),
    orientation: optOneOf(value, 'orientation', ['auto', 'portrait', 'landscape'] as const),
    pageRanges: optStr(value, 'pageRanges', PAGE_RANGES)?.replace(/\s+/g, ''),
    fit: optOneOf(value, 'fit', ['fit', 'fill', 'none'] as const),
    quality: optOneOf(value, 'quality', ['draft', 'normal', 'high'] as const),
  }
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as JobOptions
}
