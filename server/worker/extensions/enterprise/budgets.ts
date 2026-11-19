import type { Budget, BudgetView } from '../../../shared/enterprise'
import type { Json } from '../../http/body'
import { badRequest, notFound } from '../../http/errors'
import { optBool, oneOf, optOneOf } from '../../http/validate'
import { newId } from '../../lib/crypto'
import { first, run } from '../../lib/db'
import type { Ctx } from '../../services/context'
import { usageSettings } from '../usage/settings'
import { changed, enter } from './guard'
import { budgetMeter, budgetRows, toBudget, type BudgetRow } from './meters'
import { OVER_ACTIONS, onlyKeys, parseCycle } from './values'

const UNITS = ['cost', 'pages'] as const
const FIELDS = ['costCenterId', 'enabled', 'unit', 'amount', 'cycle', 'action']

const amountOf = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw badRequest('amount must be a whole number of at least 0 (micros for cost)')
  return value
}

async function viewOf(ctx: Ctx, workspaceId: string, b: Budget): Promise<BudgetView> {
  const { timeZone } = await usageSettings(ctx, workspaceId)
  return { ...b, usage: await budgetMeter(ctx.env, workspaceId, b, timeZone) }
}

async function budget(env: Env, workspaceId: string, id: string): Promise<Budget> {
  const row = await first<BudgetRow>(env.DB, 'SELECT * FROM budgets WHERE id = ? AND workspace_id = ?', id, workspaceId)
  if (!row) throw notFound('Budget not found')
  return toBudget(row)
}

/** Every budget with this cycle's usage, grouped by cost center. */
export async function listBudgets(ctx: Ctx, workspaceId: string): Promise<BudgetView[]> {
  await enter(ctx, workspaceId, 'read', 'costCenters', 'admin')
  return Promise.all((await budgetRows(ctx.env, workspaceId)).map((r) => viewOf(ctx, workspaceId, toBudget(r))))
}

export async function createBudget(ctx: Ctx, workspaceId: string, body: Json): Promise<BudgetView> {
  onlyKeys(body, FIELDS)
  await enter(ctx, workspaceId, 'write', 'costCenters', 'admin')
  const costCenterId = typeof body.costCenterId === 'string' ? body.costCenterId : ''
  if (!(await first(ctx.env.DB, 'SELECT 1 AS one FROM cost_centers WHERE id = ? AND workspace_id = ?', costCenterId, workspaceId))) {
    throw badRequest('costCenterId must be a cost center of this workspace', 'cost_center_invalid')
  }
  const id = newId()
  const now = Date.now()
  await run(
    ctx.env.DB,
    'INSERT INTO budgets (id, workspace_id, cost_center_id, enabled, unit, amount, cycle, action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    workspaceId,
    costCenterId,
    optBool(body, 'enabled') ?? true,
    oneOf(body, 'unit', UNITS),
    amountOf(body.amount),
    JSON.stringify(parseCycle(body.cycle)),
    optOneOf(body, 'action', OVER_ACTIONS) ?? 'block',
    now,
    now,
  )
  await changed(ctx, workspaceId, 'budget.create', id, { costCenterId }, 'usage')
  return viewOf(ctx, workspaceId, await budget(ctx.env, workspaceId, id))
}

export async function updateBudget(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<BudgetView> {
  onlyKeys(body, FIELDS.filter((f) => f !== 'costCenterId'))
  await enter(ctx, workspaceId, 'write', 'costCenters', 'admin')
  const current = await budget(ctx.env, workspaceId, id)
  await run(
    ctx.env.DB,
    'UPDATE budgets SET enabled = ?, unit = ?, amount = ?, cycle = ?, action = ?, updated_at = ? WHERE id = ?',
    optBool(body, 'enabled') ?? current.enabled,
    optOneOf(body, 'unit', UNITS) ?? current.unit,
    body.amount === undefined ? current.amount : amountOf(body.amount),
    JSON.stringify(body.cycle === undefined ? current.cycle : parseCycle(body.cycle)),
    optOneOf(body, 'action', OVER_ACTIONS) ?? current.action,
    Date.now(),
    id,
  )
  await changed(ctx, workspaceId, 'budget.update', id, { fields: Object.keys(body) }, 'usage')
  return viewOf(ctx, workspaceId, await budget(ctx.env, workspaceId, id))
}

export async function deleteBudget(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  await enter(ctx, workspaceId, 'write', 'costCenters', 'admin')
  const current = await budget(ctx.env, workspaceId, id)
  await run(ctx.env.DB, 'DELETE FROM budgets WHERE id = ?', id)
  await changed(ctx, workspaceId, 'budget.delete', id, { costCenterId: current.costCenterId }, 'usage')
}
