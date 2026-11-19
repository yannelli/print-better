import type { LimitScope, PrintLimit, PrintRule, RuleAction, RuleConditions } from '../../../shared/policies'
import type { Cycle, OverAction, UsageUnit } from '../../../shared/usage'
import { all, parseJson } from '../../lib/db'

export const EXTENSION = 'print-policies'

export interface RuleRow {
  id: string
  workspace_id: string
  name: string
  enabled: number
  exempt_admins: number
  position: number
  conditions: string
  actions: string
  created_at: number
  updated_at: number
}

export interface LimitRow {
  id: string
  workspace_id: string
  name: string
  enabled: number
  exempt_admins: number
  scope: LimitScope['type']
  user_id: string | null
  group_id: string | null
  client_id: string | null
  printer_id: string | null
  unit: UsageUnit
  amount: number
  cycle: string
  action: OverAction
  created_at: number
  updated_at: number
}

export const toRule = (r: RuleRow): PrintRule => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled === 1,
  exemptAdmins: r.exempt_admins === 1,
  conditions: parseJson<RuleConditions>(r.conditions, {}),
  actions: parseJson<RuleAction[]>(r.actions, []),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

function scopeOf(r: LimitRow): LimitScope {
  switch (r.scope) {
    case 'member':
      return { type: 'member', id: r.user_id ?? '' }
    case 'group':
    case 'group-each':
      return { type: r.scope, id: r.group_id ?? '' }
    case 'device':
      return { type: 'device', id: r.client_id ?? '' }
    case 'printer':
      return { type: 'printer', id: r.printer_id ?? '' }
    default:
      return { type: r.scope }
  }
}

export const toLimit = (r: LimitRow): PrintLimit => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled === 1,
  exemptAdmins: r.exempt_admins === 1,
  scope: scopeOf(r),
  unit: r.unit,
  amount: r.amount,
  cycle: parseJson<Cycle>(r.cycle, { kind: 'month', startDay: 1 }),
  action: r.action,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** Top to bottom. */
export const loadRules = async (env: Env, workspaceId: string): Promise<PrintRule[]> =>
  (await all<RuleRow>(env.DB, 'SELECT * FROM print_rules WHERE workspace_id = ? ORDER BY position, created_at', workspaceId)).map(toRule)

/** Oldest first, the order limits are checked in. */
export const loadLimits = async (env: Env, workspaceId: string): Promise<PrintLimit[]> =>
  (await all<LimitRow>(env.DB, 'SELECT * FROM print_limits WHERE workspace_id = ? ORDER BY created_at, id', workspaceId)).map(toLimit)
