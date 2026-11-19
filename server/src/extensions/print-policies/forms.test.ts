import { describe, expect, it } from 'vitest'
import type { PrintLimit, PrintRule } from '@shared/policies'
import { actionPhrase, allowancePhrase, conditionPhrases, dayList, scopePhrase } from '@shared/policy-text'
import { draftOf as limitDraft, inputOf as limitInput, parseAmount } from './limit-form'
import { draftOf as ruleDraft, inputOf as ruleInput, problemOf, without } from './rule-form'

const name = (kind: string, id: string) => `${kind}:${id}`

describe('limit form', () => {
  const limit: PrintLimit = {
    id: 'l1',
    name: 'Lab budget',
    enabled: true,
    exemptAdmins: true,
    scope: { type: 'group', id: 'g1' },
    unit: 'cost',
    amount: 12_500_000,
    cycle: { kind: 'quarter', startMonth: 2 },
    action: 'warn',
    createdAt: 0,
    updatedAt: 0,
  }

  it('starts a new limit at 500 pages a month for each member', () => {
    expect(limitInput({ ...limitDraft(), name: 'Pages' })).toEqual({
      name: 'Pages',
      enabled: true,
      exemptAdmins: false,
      scope: { type: 'each-member' },
      unit: 'pages',
      amount: 500,
      cycle: { kind: 'month', startDay: 1 },
      action: 'block',
    })
  })

  it('round-trips a saved limit, with money typed as a decimal', () => {
    const draft = limitDraft(limit)
    expect(draft.amount).toBe('12.5')
    const { name, enabled, exemptAdmins, scope, unit, amount, cycle, action } = limit
    expect(limitInput(draft)).toEqual({ name, enabled, exemptAdmins, scope, unit, amount, cycle, action })
  })

  it('waits for a name, a valid amount, and the member, group, device or printer a scope names', () => {
    expect(limitInput({ ...limitDraft(), name: ' ' })).toBeNull()
    expect(limitInput({ ...limitDraft(), name: 'x', amount: '1.5' })).toBeNull()
    expect(limitInput({ ...limitDraft(), name: 'x', scope: 'printer', subject: '' })).toBeNull()
    expect(limitInput({ ...limitDraft(), name: 'x', scope: 'printer', subject: 'p1' })?.scope).toEqual({ type: 'printer', id: 'p1' })
    expect([parseAmount('pages', '012'), parseAmount('jobs', '-1'), parseAmount('cost', '0.05')]).toEqual([12, null, 50_000])
  })
})

describe('rule form', () => {
  const ready = { ...ruleDraft(), name: 'Save paper' }

  it('starts with one action and no conditions, ready once named', () => {
    expect(problemOf(ruleDraft())).toBe('Give the rule a name.')
    expect(problemOf(ready)).toBeNull()
    expect(ruleInput(ready)).toEqual({ name: 'Save paper', enabled: true, exemptAdmins: false, conditions: {}, actions: [{ type: 'two-sided' }] })
  })

  it('names what is missing before saving', () => {
    const cases: [Partial<typeof ready>, string][] = [
      [{ conditions: { who: [] } }, 'Pick who sent it, or remove that condition.'],
      [{ conditions: { pages: {} } }, 'Set the fewest or most pages.'],
      [{ conditions: { pages: { min: 9, max: 3 } } }, 'The fewest pages are more than the most.'],
      [{ conditions: { time: { days: [1], from: '25:00', to: '08:00' } } }, 'Pick days and times as HH:MM.'],
      [{ conditions: { minCopies: undefined } }, 'Fill in each number.'],
      [{ actions: [] }, 'Add at least one action.'],
      [{ actions: [{ type: 'block', message: ' ' }] }, 'Write the message for each block or note.'],
      [{ actions: [{ type: 'redirect', printerId: '' }] }, 'Pick the printer to send jobs to.'],
      [{ actions: [{ type: 'max-copies', copies: 0 }] }, 'Set the most copies allowed.'],
    ]
    for (const [patch, problem] of cases) expect(problemOf({ ...ready, ...patch }), problem).toBe(problem)
  })

  it('removes a condition and trims messages', () => {
    expect(without({ color: true, sides: 'two-sided' }, 'color')).toEqual({ sides: 'two-sided' })
    expect(ruleInput({ ...ready, actions: [{ type: 'note', message: ' Saved paper ' }] }).actions).toEqual([{ type: 'note', message: 'Saved paper' }])
    const rule = { id: 'r1', createdAt: 0, updatedAt: 0, ...ruleInput(ready) } as PrintRule
    expect(ruleDraft(rule)).toEqual({ ...ready, enabled: true, exemptAdmins: false })
  })
})

describe('rule and limit sentences', () => {
  it('describe each condition and action', () => {
    const phrases = conditionPhrases(
      {
        who: [{ type: 'user', id: 'u1' }, { type: 'group', id: 'g1' }],
        sources: ['web', 'email'],
        printers: ['p1'],
        pages: { min: 10, max: 50 },
        minCopies: 2,
        color: false,
        sides: 'two-sided',
        fileKinds: ['pdf', 'image'],
        minSizeMb: 5,
        time: { days: [6, 0], from: '00:00', to: '00:00' },
      },
      name,
    )
    expect(phrases).toEqual([
      'From user:u1 or group:g1',
      'Sent from the web app or email',
      'To printer:p1',
      '10 to 50 pages',
      '2 copies or more',
      'In black and white',
      'Two-sided',
      'PDFs or images',
      'Files of 5 MB or more',
      'Sat and Sun, all day',
    ])
    expect(conditionPhrases({ pages: { max: 5 } }, name)).toEqual(['Up to 5 pages'])
    expect(actionPhrase({ type: 'redirect', printerId: 'p2' }, name)).toBe('Send to printer:p2')
    expect(actionPhrase({ type: 'max-copies', copies: 3 }, name)).toBe('Limit copies to 3')
  })

  it('shorten runs of days and describe scopes and amounts', () => {
    expect([dayList([1, 2, 3, 4, 5]), dayList([0, 1, 2, 3, 4, 5, 6]), dayList([1, 3, 5]), dayList([5, 6, 0])]).toEqual(['Mon to Fri', 'Every day', 'Mon, Wed and Fri', 'Fri to Sun'])
    expect(scopePhrase({ type: 'group-each', id: 'g1' }, name)).toBe('Each in group:g1')
    expect(allowancePhrase({ unit: 'cost', amount: 10_000_000, cycle: { kind: 'month', startDay: 1 }, action: 'warn' }, 'USD', 'en-US')).toBe('$10.00 a month, then warns')
  })
})
