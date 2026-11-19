import type { Cycle } from '../../../shared/usage'

const DAY = 86_400_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface LocalDate {
  year: number
  /** 1 to 12. */
  month: number
  day: number
}

export interface LocalTime extends LocalDate {
  hour: number
  minute: number
  second: number
  /** 0 is Sunday. */
  weekday: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    const fields = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' } as const
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', ...fields })
    formatters.set(timeZone, f)
  }
  return f
}

export const isTimeZone = (name: string): boolean => {
  try {
    formatter(name)
    return true
  } catch {
    return false
  }
}

/** The wall clock in `timeZone` at instant `at`. */
export function localTime(timeZone: string, at: number): LocalTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(at).map((p) => [p.type, p.value]))
  const n = (key: string) => Number(parts[key])
  return { year: n('year'), month: n('month'), day: n('day'), hour: n('hour'), minute: n('minute'), second: n('second'), weekday: WEEKDAYS.indexOf(parts.weekday) }
}

const offsetAt = (timeZone: string, at: number): number => {
  const t = localTime(timeZone, at)
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - Math.floor(at / 1000) * 1000
}

const toDate = (ms: number): LocalDate => {
  const d = new Date(ms)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

const addDays = (d: LocalDate, days: number): LocalDate => toDate(Date.UTC(d.year, d.month - 1, d.day + days))
const addMonths = (d: LocalDate, months: number): LocalDate => toDate(Date.UTC(d.year, d.month - 1 + months, d.day))

/** The first instant of a local date. Skipped midnights start when the clock jumps; repeated ones at the first. */
export function localMidnight(timeZone: string, date: LocalDate): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day)
  const offsets = new Set([guess - DAY, guess, guess + DAY].map((at) => offsetAt(timeZone, at)))
  const candidates = [...offsets].map((offset) => guess - offset)
  const valid = candidates.filter((at) => {
    const t = localTime(timeZone, at)
    return t.year === date.year && t.month === date.month && t.day === date.day && t.hour === 0 && t.minute === 0
  })
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates)
}

function firstDate(cycle: Cycle, today: LocalDate): LocalDate {
  switch (cycle.kind) {
    case 'day':
      return today
    case 'week': {
      const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay()
      return addDays(today, -((weekday - cycle.firstDay + 7) % 7))
    }
    case 'month': {
      const start = { ...today, day: cycle.startDay }
      return today.day >= cycle.startDay ? start : addMonths(start, -1)
    }
    case 'quarter':
      return addMonths({ ...today, day: 1 }, -((today.month - cycle.startMonth + 12) % 3))
    case 'year':
      return { year: today.month >= cycle.startMonth ? today.year : today.year - 1, month: cycle.startMonth, day: 1 }
  }
}

const NEXT: Record<Cycle['kind'], (d: LocalDate) => LocalDate> = {
  day: (d) => addDays(d, 1),
  week: (d) => addDays(d, 7),
  month: (d) => addMonths(d, 1),
  quarter: (d) => addMonths(d, 3),
  year: (d) => addMonths(d, 12),
}

export interface CycleSpan {
  start: number
  /** The next cycle's first instant. */
  end: number
}

/** The cycle containing `at`, as instants: local midnights in `timeZone`. */
export function cycleAt(cycle: Cycle, timeZone: string, at: number): CycleSpan {
  const now = localTime(timeZone, at)
  const first = firstDate(cycle, now)
  return { start: localMidnight(timeZone, first), end: localMidnight(timeZone, NEXT[cycle.kind](first)) }
}

export const previousCycle = (cycle: Cycle, timeZone: string, at: number): CycleSpan => cycleAt(cycle, timeZone, cycleAt(cycle, timeZone, at).start - 1)
