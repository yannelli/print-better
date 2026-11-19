import type { LimitScope, PrintLimit, PrintLimitInput } from '@shared/policies'
import type { Cycle, OverAction, UsageUnit } from '@shared/usage'
import type { Choice } from '@/routes/settings/fields'
import { moneyText, parseMoney } from '../usage/words'

type ScopeType = LimitScope['type']
/** What a named scope picks: a member, group, device or printer. */
export type Named = 'user' | 'group' | 'client' | 'printer'

export const SCOPES: (Choice<ScopeType> & { picks?: Named; needsGroups?: boolean })[] = [
  { value: 'each-member', label: 'Each member', description: 'Everyone has their own count.' },
  { value: 'member', label: 'One member', picks: 'user' },
  { value: 'group', label: 'A group, shared', description: 'One count for everyone in the group.', picks: 'group', needsGroups: true },
  { value: 'group-each', label: 'Each member of a group', description: 'Everyone in the group has their own count.', picks: 'group', needsGroups: true },
  { value: 'each-device', label: 'Each device', description: "Jobs from each computer's print window." },
  { value: 'device', label: 'One device', picks: 'client' },
  { value: 'printer', label: 'One printer', description: 'Every job sent to it, from anyone.', picks: 'printer' },
  { value: 'workspace', label: 'The whole workspace', description: 'Every job.' },
]

export const UNITS: Choice<UsageUnit>[] = [
  { value: 'pages', label: 'Pages', description: 'Printed sides, times copies.' },
  { value: 'sheets', label: 'Sheets of paper' },
  { value: 'jobs', label: 'Jobs' },
  { value: 'cost', label: 'Cost', description: 'From the prices in Workspace settings > Prices.' },
]

export const ACTIONS: Choice<OverAction>[] = [
  { value: 'block', label: 'Refuse the job', description: 'The sender sees what is left and when it starts over.' },
  { value: 'warn', label: 'Print it with a warning', description: 'A note on the job says it went over.' },
  { value: 'approval', label: 'Require approval', description: 'Needs Enterprise controls with approvals on. Until then the job is refused.' },
]

export interface LimitDraft {
  name: string
  scope: ScopeType
  /** The member, group, device or printer of a named scope. */
  subject: string
  unit: UsageUnit
  /** As typed: a whole number, or money for cost. */
  amount: string
  cycle: Cycle
  action: OverAction
  exemptAdmins: boolean
  enabled: boolean
}

export const amountText = (unit: UsageUnit, amount: number): string => (unit === 'cost' ? moneyText(amount) : String(amount))

export function draftOf(limit?: PrintLimit): LimitDraft {
  if (!limit) {
    return { name: '', scope: 'each-member', subject: '', unit: 'pages', amount: '500', cycle: { kind: 'month', startDay: 1 }, action: 'block', exemptAdmins: false, enabled: true }
  }
  const subject = 'id' in limit.scope ? limit.scope.id : ''
  const { name, unit, cycle, action, exemptAdmins, enabled } = limit
  return { name, scope: limit.scope.type, subject, unit, amount: amountText(unit, limit.amount), cycle, action, exemptAdmins, enabled }
}

/** A typed amount in the unit's terms (micros for cost), or null while it isn't valid. */
export function parseAmount(unit: UsageUnit, text: string): number | null {
  if (unit === 'cost') return parseMoney(text)
  return /^\d{1,12}$/.test(text.trim()) ? Number(text.trim()) : null
}

/** The request for a draft, or null while something is missing. */
export function inputOf(d: LimitDraft): PrintLimitInput | null {
  const amount = parseAmount(d.unit, d.amount)
  const picks = SCOPES.find((s) => s.value === d.scope)?.picks
  if (!d.name.trim() || amount === null || (picks && !d.subject)) return null
  const scope = (picks ? { type: d.scope, id: d.subject } : { type: d.scope }) as LimitScope
  return { name: d.name.trim(), enabled: d.enabled, exemptAdmins: d.exemptAdmins, scope, unit: d.unit, amount, cycle: d.cycle, action: d.action }
}
