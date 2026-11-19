import { describe, expect, it } from 'vitest'
import type { Cycle } from '../shared/usage'
import { cycleAt, localMidnight, previousCycle } from '../worker/extensions/usage/cycles'

const HOUR = 3_600_000
const iso = (span: { start: number; end: number }) => [new Date(span.start).toISOString(), new Date(span.end).toISOString()]
const at = (text: string) => Date.parse(text)
const DAY: Cycle = { kind: 'day' }

describe('cycles in the workspace time zone', () => {
  it('start every day, week, month, quarter and year at local midnight', () => {
    const now = at('2026-11-19T15:30:00Z') // A Thursday.
    expect(iso(cycleAt(DAY, 'UTC', now))).toEqual(['2026-11-19T00:00:00.000Z', '2026-11-20T00:00:00.000Z'])
    expect(iso(cycleAt({ kind: 'week', firstDay: 1 }, 'UTC', now))).toEqual(['2026-11-16T00:00:00.000Z', '2026-11-23T00:00:00.000Z'])
    expect(iso(cycleAt({ kind: 'week', firstDay: 4 }, 'UTC', now))).toEqual(['2026-11-19T00:00:00.000Z', '2026-11-26T00:00:00.000Z'])
    expect(iso(cycleAt({ kind: 'month', startDay: 1 }, 'UTC', now))).toEqual(['2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'])
    expect(iso(cycleAt({ kind: 'quarter', startMonth: 1 }, 'UTC', now))).toEqual(['2026-10-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'])
    expect(iso(cycleAt({ kind: 'quarter', startMonth: 2 }, 'UTC', now))).toEqual(['2026-11-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z'])
    expect(iso(cycleAt({ kind: 'year', startMonth: 7 }, 'UTC', now))).toEqual(['2026-07-01T00:00:00.000Z', '2027-07-01T00:00:00.000Z'])
    expect(iso(cycleAt({ kind: 'year', startMonth: 12 }, 'UTC', now))).toEqual(['2025-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'])
  })

  it('start a month on the chosen day, in the month before until that day comes', () => {
    const month: Cycle = { kind: 'month', startDay: 20 }
    expect(iso(cycleAt(month, 'UTC', at('2026-11-19T23:59:59Z')))).toEqual(['2026-10-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z'])
    expect(iso(cycleAt(month, 'UTC', at('2026-11-20T00:00:00Z')))).toEqual(['2026-11-20T00:00:00.000Z', '2026-12-20T00:00:00.000Z'])
    expect(iso(cycleAt({ kind: 'month', startDay: 28 }, 'UTC', at('2027-03-01T12:00:00Z')))).toEqual(['2027-02-28T00:00:00.000Z', '2027-03-28T00:00:00.000Z'])
  })

  it('follow the zone, not UTC: a month in Chicago starts at 6 in the morning UTC', () => {
    expect(iso(cycleAt({ kind: 'month', startDay: 1 }, 'America/Chicago', at('2026-12-01T03:00:00Z')))).toEqual(['2026-11-01T05:00:00.000Z', '2026-12-01T06:00:00.000Z'])
    expect(iso(cycleAt({ kind: 'month', startDay: 1 }, 'Europe/Berlin', at('2026-11-15T12:00:00Z')))).toEqual(['2026-10-31T23:00:00.000Z', '2026-11-30T23:00:00.000Z'])
  })

  it('last 23 or 25 hours on daylight saving days, without drifting', () => {
    const spring = cycleAt(DAY, 'America/Chicago', at('2026-03-08T12:00:00Z'))
    const fall = cycleAt(DAY, 'America/Chicago', at('2026-11-01T12:00:00Z'))
    expect((spring.end - spring.start) / HOUR).toBe(23)
    expect((fall.end - fall.start) / HOUR).toBe(25)
    expect(iso(cycleAt(DAY, 'America/Chicago', at('2026-03-09T12:00:00Z')))).toEqual(['2026-03-09T05:00:00.000Z', '2026-03-10T05:00:00.000Z'])
  })

  it('start when the clock jumps where a zone skips midnight, and at the first one where midnight repeats', () => {
    // Havana springs from 00:00 to 01:00 on March 8, 2026, and falls from 01:00 back to 00:00 on November 1.
    expect(new Date(localMidnight('America/Havana', { year: 2026, month: 3, day: 8 })).toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(new Date(localMidnight('America/Havana', { year: 2026, month: 11, day: 1 })).toISOString()).toBe('2026-11-01T04:00:00.000Z')
    const skipped = cycleAt(DAY, 'America/Havana', at('2026-03-08T12:00:00Z'))
    expect((skipped.end - skipped.start) / HOUR).toBe(23)
  })

  it('go back one cycle for the previous one', () => {
    expect(iso(previousCycle({ kind: 'month', startDay: 1 }, 'UTC', at('2026-11-19T15:30:00Z')))).toEqual(['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'])
    expect(iso(previousCycle({ kind: 'week', firstDay: 0 }, 'UTC', at('2026-11-19T15:30:00Z')))).toEqual(['2026-11-08T00:00:00.000Z', '2026-11-15T00:00:00.000Z'])
    expect(iso(previousCycle({ kind: 'year', startMonth: 1 }, 'America/Chicago', at('2026-01-01T12:00:00Z')))).toEqual(['2025-01-01T06:00:00.000Z', '2026-01-01T06:00:00.000Z'])
  })
})
