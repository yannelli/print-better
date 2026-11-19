import type { JobOptions, Printer, Sides } from '@shared/types'
import { paperName } from '@/lib/format'
import { SIDES } from '@/lib/words'
import type { Choice } from './choice-select'

export type ColorChoice = 'color' | 'monochrome'

/** What the form shows before anyone touches it: printer defaults, then sensible fallbacks. */
export function startingOptions(printer: Printer): JobOptions {
  const d = printer.defaults
  const media = d.media ?? printer.capabilities.mediaDefault ?? printer.capabilities.media[0]
  return {
    ...d,
    copies: d.copies ?? 1,
    colorMode: printer.capabilities.color && d.colorMode !== 'monochrome' ? 'color' : 'monochrome',
    sides: d.sides ?? 'one-sided',
    media,
    orientation: d.orientation ?? 'auto',
    fit: d.fit ?? 'fit',
    quality: d.quality ?? 'normal',
    pageRanges: d.pageRanges ?? '',
  }
}

/** Only the fields someone changed, so untouched settings keep following the printer's defaults. */
export function changedOptions(start: JobOptions, current: JobOptions): JobOptions {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(current) as (keyof JobOptions)[]) {
    if (current[key] !== start[key] && current[key] !== '' && current[key] !== undefined) out[key] = current[key]
  }
  return out as JobOptions
}

export const PAGE_RANGES = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/

export const COLOR_CHOICES: Choice<ColorChoice>[] = [
  { value: 'color', label: 'Color' },
  { value: 'monochrome', label: 'Black and white' },
]

export const SIDE_CHOICES = (Object.keys(SIDES) as Sides[]).map((value) => ({ value, label: SIDES[value] }))

export const ORIENTATION_CHOICES: Choice<NonNullable<JobOptions['orientation']>>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'portrait', label: 'Portrait (tall)' },
  { value: 'landscape', label: 'Landscape (wide)' },
]

export const FIT_CHOICES: Choice<NonNullable<JobOptions['fit']>>[] = [
  { value: 'fit', label: 'Shrink to fit the page' },
  { value: 'fill', label: 'Fill the whole page' },
  { value: 'none', label: 'Actual size' },
]

export const QUALITY_CHOICES: Choice<NonNullable<JobOptions['quality']>>[] = [
  { value: 'draft', label: 'Draft (faster, uses less ink)' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'Best' },
]

export function paperChoices(printer: Printer): Choice<string>[] {
  return printer.capabilities.media.map((value) => ({ value, label: paperName(value) }))
}
