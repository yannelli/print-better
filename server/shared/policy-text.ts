// Plain sentences for rules and limits, shared by the web app and MCP summaries.

import type { FileKind, LimitScope, RuleAction, RuleConditions } from './policies'
import type { JobSource } from './printing'
import type { Cycle, OverAction, UsageUnit } from './usage'
import { formatAmount } from './usage-text'

/** A name for an id in a rule or limit; callers without names can return the id. */
export type NameOf = (kind: 'user' | 'group' | 'client' | 'printer', id: string) => string

/** For text without names, such as MCP summaries: "member u1", "device c1". */
export const idNames: NameOf = (kind, id) => `${kind === 'client' ? 'device' : kind === 'user' ? 'member' : kind} ${id}`

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const SOURCE_WORDS: Record<Exclude<JobSource, 'lan'>, string> = {
  web: 'the web app',
  api: 'the API',
  mcp: 'AI assistants',
  email: 'email',
  device: "a computer's print window",
  test: 'test pages',
}
export const FILE_KIND_WORDS: Record<FileKind, string> = { pdf: 'PDFs', image: 'images', text: 'text' }

/** "a, b or c". */
export function orList(items: readonly string[], last = 'or'): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`
}

/** "Mon to Fri", "Sat and Sun", "Mon, Wed and Fri", weeks starting on Monday. */
export function dayList(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
  if (sorted.length === 7) return 'Every day'
  const run = sorted.every((d, i) => i === 0 || (sorted[i - 1] + 1) % 7 === d)
  return run && sorted.length > 2 ? `${DAYS[sorted[0]]} to ${DAYS[sorted[sorted.length - 1]]}` : orList(sorted.map((d) => DAYS[d]), 'and')
}

/** Each condition that is set, as a short phrase; none means every job. */
export function conditionPhrases(c: RuleConditions, name: NameOf): string[] {
  const phrases: string[] = []
  if (c.who?.length) phrases.push(`From ${orList(c.who.map((s) => name(s.type, s.id)))}`)
  if (c.sources?.length) phrases.push(`Sent from ${orList(c.sources.map((s) => SOURCE_WORDS[s]))}`)
  if (c.printers?.length) phrases.push(`To ${orList(c.printers.map((id) => name('printer', id)))}`)
  const { min, max } = c.pages ?? {}
  if (min !== undefined && max !== undefined) phrases.push(`${min} to ${max} pages`)
  else if (min !== undefined) phrases.push(`${min} pages or more`)
  else if (max !== undefined) phrases.push(`Up to ${max} pages`)
  if (c.minCopies !== undefined) phrases.push(`${c.minCopies} copies or more`)
  if (c.color !== undefined) phrases.push(c.color ? 'In color' : 'In black and white')
  if (c.sides) phrases.push(c.sides === 'one-sided' ? 'One-sided' : 'Two-sided')
  if (c.fileKinds?.length) phrases.push(orList(c.fileKinds.map((k) => FILE_KIND_WORDS[k])))
  if (c.minSizeMb !== undefined) phrases.push(`Files of ${c.minSizeMb} MB or more`)
  if (c.time) phrases.push(`${dayList(c.time.days)}, ${c.time.from === c.time.to ? 'all day' : `${c.time.from} to ${c.time.to}`}`)
  return phrases
}

export function actionPhrase(a: RuleAction, name: NameOf): string {
  switch (a.type) {
    case 'block':
      return `Block: ${a.message}`
    case 'two-sided':
      return 'Print two-sided'
    case 'monochrome':
      return 'Print in black and white'
    case 'max-copies':
      return `Limit copies to ${a.copies}`
    case 'redirect':
      return `Send to ${name('printer', a.printerId)}`
    case 'approval':
      return 'Require approval'
    case 'release':
      return 'Hold for release'
    case 'note':
      return `Add a note: ${a.message}`
  }
}

/** Who a limit counts: "Each member", "Sam", "Lab, shared", "Each in Lab". */
export function scopePhrase(s: LimitScope, name: NameOf): string {
  switch (s.type) {
    case 'each-member':
      return 'Each member'
    case 'each-device':
      return 'Each device'
    case 'workspace':
      return 'The whole workspace'
    case 'member':
      return name('user', s.id)
    case 'device':
      return name('client', s.id)
    case 'printer':
      return name('printer', s.id)
    case 'group':
      return `${name('group', s.id)}, shared`
    case 'group-each':
      return `Each in ${name('group', s.id)}`
  }
}

const PER: Record<Cycle['kind'], string> = { day: 'a day', week: 'a week', month: 'a month', quarter: 'a quarter', year: 'a year' }
const WHEN_REACHED: Record<OverAction, string> = { block: 'blocks', warn: 'warns', approval: 'needs approval' }

/** "500 pages a month, then blocks". */
export function allowancePhrase(limit: { unit: UsageUnit; amount: number; cycle: Cycle; action: OverAction }, currency: string, locale?: string): string {
  return `${formatAmount(limit.unit, limit.amount, currency, locale)} ${PER[limit.cycle.kind]}, then ${WHEN_REACHED[limit.action]}`
}
