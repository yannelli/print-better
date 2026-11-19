import type { PrintRule, PrintRuleInput, RuleAction, RuleConditions } from '@shared/policies'
import type { Choice } from '@/routes/settings/fields'

export type ConditionKey = keyof RuleConditions
export type ActionType = RuleAction['type']

export const CONDITIONS: { key: ConditionKey; label: string }[] = [
  { key: 'who', label: 'Who sent it' },
  { key: 'sources', label: 'Where it came from' },
  { key: 'printers', label: 'Printer' },
  { key: 'pages', label: 'Pages' },
  { key: 'minCopies', label: 'Copies' },
  { key: 'color', label: 'Color' },
  { key: 'sides', label: 'Sides' },
  { key: 'fileKinds', label: 'File type' },
  { key: 'minSizeMb', label: 'File size' },
  { key: 'time', label: 'Time' },
]

/** What a condition starts as when it is added. */
export const NEW_CONDITION: Required<RuleConditions> = {
  who: [],
  sources: ['email'],
  printers: [],
  pages: { min: 10 },
  minCopies: 2,
  color: true,
  sides: 'one-sided',
  fileKinds: ['pdf'],
  minSizeMb: 10,
  time: { days: [1, 2, 3, 4, 5], from: '18:00', to: '08:00' },
}

export const ACTION_TYPES: Choice<ActionType>[] = [
  { value: 'block', label: 'Block', description: 'Refuse the job with your message.' },
  { value: 'two-sided', label: 'Print two-sided', description: 'Long edge, when the printer can.' },
  { value: 'monochrome', label: 'Print in black and white' },
  { value: 'max-copies', label: 'Limit copies' },
  { value: 'redirect', label: 'Send to another printer', description: 'Only to a printer the sender may print to.' },
  { value: 'approval', label: 'Require approval', description: 'Needs Enterprise controls with approvals on. Skipped until then.' },
  { value: 'release', label: 'Hold for release', description: 'Needs Enterprise controls with secure release on. Skipped until then.' },
  { value: 'note', label: 'Add a note', description: 'Shown on the job.' },
]

export const NEW_ACTION: Record<ActionType, RuleAction> = {
  block: { type: 'block', message: '' },
  'two-sided': { type: 'two-sided' },
  monochrome: { type: 'monochrome' },
  'max-copies': { type: 'max-copies', copies: 1 },
  redirect: { type: 'redirect', printerId: '' },
  approval: { type: 'approval' },
  release: { type: 'release' },
  note: { type: 'note', message: '' },
}

export interface RuleDraft {
  name: string
  enabled: boolean
  exemptAdmins: boolean
  conditions: RuleConditions
  actions: RuleAction[]
}

export const draftOf = (rule?: PrintRule): RuleDraft =>
  rule
    ? { name: rule.name, enabled: rule.enabled, exemptAdmins: rule.exemptAdmins, conditions: rule.conditions, actions: rule.actions }
    : { name: '', enabled: true, exemptAdmins: false, conditions: {}, actions: [NEW_ACTION['two-sided']] }

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Why the draft can't be saved yet, in a few words; null when it can. */
export function problemOf(d: RuleDraft): string | null {
  const c = d.conditions
  if (!d.name.trim()) return 'Give the rule a name.'
  if (c.who?.length === 0) return 'Pick who sent it, or remove that condition.'
  if (c.sources?.length === 0 || c.fileKinds?.length === 0) return 'Pick at least one choice in each condition.'
  if (c.printers?.length === 0) return 'Pick a printer, or remove that condition.'
  if (c.pages && c.pages.min === undefined && c.pages.max === undefined) return 'Set the fewest or most pages.'
  if (c.pages?.min !== undefined && c.pages.max !== undefined && c.pages.min > c.pages.max) return 'The fewest pages are more than the most.'
  if (c.time && (c.time.days.length === 0 || !TIME.test(c.time.from) || !TIME.test(c.time.to))) return 'Pick days and times as HH:MM.'
  if (('minCopies' in c && !c.minCopies) || ('minSizeMb' in c && !c.minSizeMb)) return 'Fill in each number.'
  if (d.actions.length === 0) return 'Add at least one action.'
  for (const a of d.actions) {
    if ((a.type === 'block' || a.type === 'note') && !a.message.trim()) return 'Write the message for each block or note.'
    if (a.type === 'redirect' && !a.printerId) return 'Pick the printer to send jobs to.'
    if (a.type === 'max-copies' && !(a.copies >= 1)) return 'Set the most copies allowed.'
  }
  return null
}

export const inputOf = (d: RuleDraft): PrintRuleInput => ({
  name: d.name.trim(),
  enabled: d.enabled,
  exemptAdmins: d.exemptAdmins,
  conditions: d.conditions,
  actions: d.actions.map((a) => (a.type === 'block' || a.type === 'note' ? { ...a, message: a.message.trim() } : a)),
})

/** The conditions without `key`. */
export function without(c: RuleConditions, key: ConditionKey): RuleConditions {
  const rest = { ...c }
  delete rest[key]
  return rest
}
