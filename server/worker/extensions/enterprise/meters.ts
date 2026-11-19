import type { Budget } from '../../../shared/enterprise'
import type { JobUsage } from '../../../shared/printing'
import type { Cycle, OverAction, UsageMeter, UsageUnit } from '../../../shared/usage'
import { all, first, parseJson } from '../../lib/db'
import { cycleAt } from '../usage/cycles'

export interface BudgetRow {
  id: string
  cost_center_id: string
  enabled: number
  unit: 'cost' | 'pages'
  amount: number
  cycle: string
  action: OverAction
  created_at: number
  updated_at: number
}

export const toBudget = (r: BudgetRow): Budget => ({
  id: r.id,
  costCenterId: r.cost_center_id,
  enabled: r.enabled === 1,
  unit: r.unit,
  amount: r.amount,
  cycle: parseJson<Cycle>(r.cycle, { kind: 'month', startDay: 1 }),
  action: r.action,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export const budgetRows = (env: Env, workspaceId: string, costCenterId: string | null = null): Promise<BudgetRow[]> =>
  all<BudgetRow>(
    env.DB,
    `SELECT b.* FROM budgets b JOIN cost_centers c ON c.id = b.cost_center_id
     WHERE b.workspace_id = ? AND (? IS NULL OR b.cost_center_id = ?) ORDER BY c.name COLLATE NOCASE, b.created_at`,
    workspaceId,
    costCenterId,
    costCenterId,
  )

const COLUMN: Record<Budget['unit'], string> = { pages: 'pages', cost: 'cost_micros' }

/** The budget's current cycle, counting jobs still waiting or printing. */
export async function budgetMeter(env: Env, workspaceId: string, budget: Budget, timeZone: string, at = Date.now()): Promise<UsageMeter> {
  const span = cycleAt(budget.cycle, timeZone, at)
  const row = await first<{ used: number }>(
    env.DB,
    `SELECT COALESCE(SUM(${COLUMN[budget.unit]}), 0) AS used FROM usage_entries WHERE workspace_id = ? AND cost_center_id = ? AND at >= ? AND at < ?`,
    workspaceId,
    budget.costCenterId,
    span.start,
    span.end,
  )
  const used = row?.used ?? 0
  return { unit: budget.unit, used, amount: budget.amount, left: Math.max(0, budget.amount - used), start: span.start, end: span.end }
}

/** How much one job adds to a count. */
export function amountOf(unit: UsageUnit, usage: JobUsage): number {
  switch (unit) {
    case 'pages':
      return usage.pages
    case 'sheets':
      return usage.sheets
    case 'jobs':
      return 1
    case 'cost':
      return usage.costMicros
  }
}
