import { isoDay } from './words'

export type RangePreset = 'month' | 'last-month' | 'days-30' | 'year' | 'custom'

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'days-30', label: 'Last 30 days' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom dates' },
]

export interface DayRange {
  from: string
  to: string
}

/** Local dates, both included; ranges that are still running end today. */
export function presetRange(preset: Exclude<RangePreset, 'custom'>, now = new Date()): DayRange {
  const y = now.getFullYear()
  const m = now.getMonth()
  switch (preset) {
    case 'month':
      return { from: isoDay(new Date(y, m, 1)), to: isoDay(now) }
    case 'last-month':
      return { from: isoDay(new Date(y, m - 1, 1)), to: isoDay(new Date(y, m, 0)) }
    case 'days-30':
      return { from: isoDay(new Date(y, m, now.getDate() - 29)), to: isoDay(now) }
    case 'year':
      return { from: isoDay(new Date(y, 0, 1)), to: isoDay(now) }
  }
}

/** Reports cover at most 366 days. */
export function rangeProblem({ from, to }: DayRange): string | null {
  if (!from || !to) return 'Choose both dates.'
  if (from > to) return 'The first date must come before the last.'
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1
  return days > 366 ? 'Choose at most 366 days.' : null
}
