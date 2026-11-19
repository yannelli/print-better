// Print rules and limits (docs/print-policies.md). Shared parts live in usage.ts.

import type { AccessSubject } from './access'
import type { JobSource } from './printing'
import type { Cycle, OverAction, UsageMeter, UsageUnit } from './usage'

/** A member (`user`), a group (needs Printer access), or a device (`client`). */
export type PolicySubject = Exclude<AccessSubject, { type: 'everyone' }>

export type FileKind = 'pdf' | 'image' | 'text'

/** Every condition that is set must match; a rule without conditions matches every job. */
export interface RuleConditions {
  who?: PolicySubject[]
  sources?: Exclude<JobSource, 'lan'>[]
  printers?: string[]
  /** Total pages: pages in the chosen ranges, times copies. */
  pages?: { min?: number; max?: number }
  minCopies?: number
  /** True: the job would print in color (it asks for color, or for automatic on a color printer). */
  color?: boolean
  sides?: 'one-sided' | 'two-sided'
  fileKinds?: FileKind[]
  minSizeMb?: number
  /** Workspace time zone. `days`: 0 is Sunday. "HH:MM" times; `to` before `from` crosses midnight. */
  time?: { days: number[]; from: string; to: string }
}

export type RuleAction =
  | { type: 'block'; message: string }
  | { type: 'two-sided' }
  | { type: 'monochrome' }
  | { type: 'max-copies'; copies: number }
  | { type: 'redirect'; printerId: string }
  /** `approval` and `release` need Enterprise controls and are skipped while it is off. */
  | { type: 'approval' }
  | { type: 'release' }
  | { type: 'note'; message: string }

export interface PrintRule {
  id: string
  name: string
  enabled: boolean
  /** Doesn't apply to owners and admins. */
  exemptAdmins: boolean
  conditions: RuleConditions
  actions: RuleAction[]
  createdAt: number
  updatedAt: number
}

/** `POST /policies/rules` adds the rule at the bottom; `PATCH /policies/rules/:id` takes any of these. */
export interface PrintRuleInput {
  name: string
  enabled?: boolean
  exemptAdmins?: boolean
  conditions?: RuleConditions
  actions: RuleAction[]
}

/** Who a limit counts. `each-*` and `group-each` keep one count per member or device. */
export type LimitScope =
  | { type: 'each-member' }
  | { type: 'member'; id: string }
  /** One count shared by the group's members and devices. */
  | { type: 'group'; id: string }
  | { type: 'group-each'; id: string }
  | { type: 'each-device' }
  | { type: 'device'; id: string }
  | { type: 'printer'; id: string }
  | { type: 'workspace' }

export interface PrintLimit {
  id: string
  name: string
  enabled: boolean
  exemptAdmins: boolean
  scope: LimitScope
  unit: UsageUnit
  /** In `unit`; micros for cost. */
  amount: number
  cycle: Cycle
  /** `approval` needs Enterprise controls; while it is off the limit blocks instead. */
  action: OverAction
  createdAt: number
  updatedAt: number
}

/** `POST /policies/limits`; `PATCH /policies/limits/:id` takes any of these. */
export interface PrintLimitInput {
  name: string
  enabled?: boolean
  exemptAdmins?: boolean
  scope: LimitScope
  unit: UsageUnit
  amount: number
  cycle: Cycle
  /** Default `block`. */
  action?: OverAction
}

/** One count of a limit in a cycle; `subject` is null when the count is shared. */
export interface LimitUsage extends UsageMeter {
  subject: PolicySubject | null
  subjectName: string | null
}

/** `GET /policies/limits` and `GET /usage?cycle=current|previous`. */
export interface PrintLimitView extends PrintLimit {
  usage: LimitUsage[]
}

/** `POST /policies/limits/:id/adjustments`: extra allowance for the current cycle only. */
export interface LimitAdjustmentInput {
  /** Whose count, for `each-*` and `group-each` limits; omitted for shared counts. */
  subject?: Exclude<PolicySubject, { type: 'group' }>
  amount: number
  note?: string
}

export interface LimitAdjustment {
  id: string
  limitId: string
  subject: Exclude<PolicySubject, { type: 'group' }> | null
  amount: number
  note: string | null
  /** The cycle it belongs to; it ends with it. */
  cycleStart: number
  createdBy: string | null
  createdAt: number
}

/** `GET /usage/me`: the limits that count the caller's jobs, on any printer. */
export interface MyUsage {
  limits: MyLimit[]
}

export interface MyLimit extends UsageMeter {
  id: string
  name: string
  scope: LimitScope
  action: OverAction
}
