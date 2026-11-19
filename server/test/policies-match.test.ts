import { describe, expect, it } from 'vitest'
import type { RuleConditions } from '../shared/policies'
import type { JobOptions } from '../shared/printing'
import type { PrinterViewRow } from '../worker/db/rows'
import type { JobDecision, JobDraft } from '../worker/extensions/hooks'
import { inWindow, matches } from '../worker/extensions/print-policies/rule-match'
import { accessFrom } from '../worker/services/permissions'

const COLOR_DUPLEX = { color: true, duplex: true, mediaDefault: 'na_letter_8.5x11in' }
const printer = (id = 'p1', capabilities: object = COLOR_DUPLEX, defaults: JobOptions = {}) =>
  ({ id, name: `Printer ${id}`, capabilities: JSON.stringify(capabilities), defaults: JSON.stringify(defaults) }) as unknown as PrinterViewRow

function draft(over: Partial<JobDraft> = {}): JobDraft {
  return {
    workspaceId: 'w1',
    jobId: 'j1',
    attempt: 1,
    source: 'web',
    userId: 'u1',
    role: 'member',
    clientId: null,
    groups: ['g1'],
    access: accessFrom(null, { kind: 'member', userId: 'u1', role: 'member' }),
    contentType: 'application/pdf',
    size: 2 * 1024 * 1024,
    documentPages: 10,
    costCenter: undefined,
    timeZone: 'America/Chicago',
    // Monday, November 16, 2026, 10:00 in Chicago.
    at: Date.parse('2026-11-16T16:00:00Z'),
    ...over,
  }
}

function decision(options: JobOptions = {}, pages = 10, row = printer()): JobDecision {
  return {
    printer: row,
    options,
    notes: [],
    approval: [],
    release: false,
    hold: null,
    costCenterId: null,
    usage: { documentPages: pages, pages, sheets: pages, colorPages: 0, costMicros: 0, estimated: true },
    meters: [],
    block: null,
    after: [],
  }
}

const match = (c: RuleConditions, job = draft(), d = decision()) => matches(c, job, d)

describe('rule conditions', () => {
  it('match every job when a rule sets none', () => {
    expect(match({})).toBe(true)
  })

  it('match who sent the job: a member, one of their groups, or a device', () => {
    expect(match({ who: [{ type: 'user', id: 'u1' }] })).toBe(true)
    expect(match({ who: [{ type: 'user', id: 'u2' }] })).toBe(false)
    expect(match({ who: [{ type: 'group', id: 'g1' }] })).toBe(true)
    expect(match({ who: [{ type: 'group', id: 'g1' }] }, draft({ groups: [] }))).toBe(false)
    expect(match({ who: [{ type: 'client', id: 'c1' }] }, draft({ userId: null, clientId: 'c1', source: 'device' }))).toBe(true)
    expect(match({ who: [{ type: 'client', id: 'c1' }] })).toBe(false)
  })

  it('match the source and the printer the job goes to', () => {
    expect(match({ sources: ['web', 'api'] })).toBe(true)
    expect(match({ sources: ['email'] })).toBe(false)
    expect(match({ printers: ['p1'] })).toBe(true)
    expect(match({ printers: ['p2'] })).toBe(false)
  })

  it('match total pages between min and max, both included', () => {
    expect(match({ pages: { min: 10 } })).toBe(true)
    expect(match({ pages: { min: 11 } })).toBe(false)
    expect(match({ pages: { max: 10 } })).toBe(true)
    expect(match({ pages: { max: 9 } })).toBe(false)
    expect(match({ pages: { min: 5, max: 20 } }, draft(), decision({}, 25))).toBe(false)
  })

  it('match copies, with the printer default when the job sets none', () => {
    expect(match({ minCopies: 2 }, draft(), decision({ copies: 2 }))).toBe(true)
    expect(match({ minCopies: 2 })).toBe(false)
    expect(match({ minCopies: 3 }, draft(), decision({}, 10, printer('p1', COLOR_DUPLEX, { copies: 3 })))).toBe(true)
  })

  it('match color: asking for color, or automatic on a color printer', () => {
    expect(match({ color: true })).toBe(true)
    expect(match({ color: true }, draft(), decision({ colorMode: 'monochrome' }))).toBe(false)
    expect(match({ color: false }, draft(), decision({}, 10, printer('p1', { color: false, duplex: true })))).toBe(true)
    expect(match({ color: true }, draft(), decision({ colorMode: 'color' }, 10, printer('p1', { color: false, duplex: true })))).toBe(true)
  })

  it('match what the job asks for, one-sided or two-sided', () => {
    expect(match({ sides: 'one-sided' })).toBe(true)
    expect(match({ sides: 'two-sided' }, draft(), decision({ sides: 'two-sided-short-edge' }))).toBe(true)
    expect(match({ sides: 'two-sided' }, draft(), decision({}, 10, printer('p1', COLOR_DUPLEX, { sides: 'two-sided-long-edge' })))).toBe(true)
    expect(match({ sides: 'two-sided' })).toBe(false)
  })

  it('match the kind of file and its size', () => {
    expect(match({ fileKinds: ['pdf'] })).toBe(true)
    expect(match({ fileKinds: ['image', 'text'] })).toBe(false)
    expect(match({ fileKinds: ['image'] }, draft({ contentType: 'image/png' }))).toBe(true)
    expect(match({ fileKinds: ['text'] }, draft({ contentType: 'text/plain' }))).toBe(true)
    expect(match({ minSizeMb: 2 })).toBe(true)
    expect(match({ minSizeMb: 2.5 })).toBe(false)
  })

  it('need every condition to match', () => {
    expect(match({ sources: ['web'], pages: { min: 11 } })).toBe(false)
    expect(match({ sources: ['web'], pages: { min: 10 }, color: true, fileKinds: ['pdf'] })).toBe(true)
  })
})

describe('time windows, in the workspace time zone', () => {
  const chicago = (local: string) => Date.parse(`${local}-06:00`)
  const weekdays = { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }
  const fridayNights = { days: [5], from: '22:00', to: '06:00' }

  it('include the start and leave out the end', () => {
    expect(inWindow(weekdays, 'America/Chicago', chicago('2026-11-16T09:00'))).toBe(true)
    expect(inWindow(weekdays, 'America/Chicago', chicago('2026-11-16T16:59'))).toBe(true)
    expect(inWindow(weekdays, 'America/Chicago', chicago('2026-11-16T17:00'))).toBe(false)
    expect(inWindow(weekdays, 'America/Chicago', chicago('2026-11-21T10:00'))).toBe(false)
    expect(inWindow(weekdays, 'UTC', chicago('2026-11-16T10:00'))).toBe(true)
    expect(inWindow(weekdays, 'UTC', chicago('2026-11-16T12:00'))).toBe(false)
  })

  it('cross midnight when to is earlier than from, belonging to the day they start', () => {
    expect(inWindow(fridayNights, 'America/Chicago', chicago('2026-11-20T23:00'))).toBe(true)
    expect(inWindow(fridayNights, 'America/Chicago', chicago('2026-11-21T05:59'))).toBe(true)
    expect(inWindow(fridayNights, 'America/Chicago', chicago('2026-11-21T06:00'))).toBe(false)
    expect(inWindow(fridayNights, 'America/Chicago', chicago('2026-11-20T05:00'))).toBe(false)
    expect(inWindow(fridayNights, 'America/Chicago', chicago('2026-11-19T23:00'))).toBe(false)
  })

  it('cover the whole day when from and to are the same', () => {
    const weekend = { days: [0, 6], from: '00:00', to: '00:00' }
    expect(inWindow(weekend, 'America/Chicago', chicago('2026-11-21T00:00'))).toBe(true)
    expect(inWindow(weekend, 'America/Chicago', chicago('2026-11-22T23:59'))).toBe(true)
    expect(inWindow(weekend, 'America/Chicago', chicago('2026-11-23T00:00'))).toBe(false)
  })

  it('apply through matches with the job time and zone', () => {
    expect(match({ time: weekdays })).toBe(true)
    expect(match({ time: weekdays }, draft({ at: chicago('2026-11-22T10:00') }))).toBe(false)
  })
})
