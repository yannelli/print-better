import type { Cycle, CycleKind } from '@shared/usage'

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const CYCLE_KINDS: { value: CycleKind; label: string }[] = [
  { value: 'day', label: 'Every day' },
  { value: 'week', label: 'Every week' },
  { value: 'month', label: 'Every month' },
  { value: 'quarter', label: 'Every quarter' },
  { value: 'year', label: 'Every year' },
]

/** Each kind as it starts out when picked: weeks from Monday, the rest from the 1st and January. */
export const FIRST_CYCLE: Record<CycleKind, Cycle> = {
  day: { kind: 'day' },
  week: { kind: 'week', firstDay: 1 },
  month: { kind: 'month', startDay: 1 },
  quarter: { kind: 'quarter', startMonth: 1 },
  year: { kind: 'year', startMonth: 1 },
}

/** "Every month", "Every week, from Monday", "Every year, from July". */
export function cycleLabel(cycle: Cycle): string {
  switch (cycle.kind) {
    case 'day':
      return 'Every day'
    case 'week':
      return `Every week, from ${WEEKDAYS[cycle.firstDay]}`
    case 'month':
      return cycle.startDay === 1 ? 'Every month' : `Every month, from day ${cycle.startDay}`
    case 'quarter':
      return cycle.startMonth === 1 ? 'Every quarter' : `Every quarter, from ${MONTHS[cycle.startMonth - 1]}`
    case 'year':
      return cycle.startMonth === 1 ? 'Every year' : `Every year, from ${MONTHS[cycle.startMonth - 1]}`
  }
}
