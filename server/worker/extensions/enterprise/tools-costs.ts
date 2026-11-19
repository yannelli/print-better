import type { BudgetView } from '../../../shared/enterprise'
import { str } from '../../http/validate'
import { ACTION, bool, choice, inWorkspace, integer, nullableText, object, output, pick, READ, REMOVE, text, UPDATE, workspaceOf, type Schema, type Tool } from '../../mcp/tool'
import { createBudget, deleteBudget, listBudgets, updateBudget } from './budgets'
import { createCostCenter, deleteCostCenter, listCostCenters, updateCostCenter } from './cost-centers'
import { putDefaults } from './defaults'

const ID_MAP = (what: string): Schema => ({
  type: 'object',
  additionalProperties: { type: ['string', 'null'] },
  description: `${what} ids to cost center ids; null removes a default`,
})

export const CYCLE = object(
  {
    kind: choice('When it starts over', ['day', 'week', 'month', 'quarter', 'year']),
    firstDay: integer('Week: first day, 0 is Sunday', 0, 6),
    startDay: integer('Month: the day it starts', 1, 28),
    startMonth: integer('Quarter or year: the month it starts', 1, 12),
  },
  ['kind'],
  'Cycle, reset at midnight in the workspace time zone',
)

const BUDGET_FIELDS = {
  enabled: bool('On or off'),
  unit: choice('What it counts', ['cost', 'pages']),
  amount: integer('Amount: pages, or micros of the workspace currency for cost (0.025 is 25000)', 0, Number.MAX_SAFE_INTEGER),
  cycle: CYCLE,
  action: choice('When reached: block, warn and allow, or require approval', ['block', 'warn', 'approval']),
}
const budgetLine = (b: BudgetView) => `${b.id}: ${b.unit} ${b.usage.used} of ${b.amount} per ${b.cycle.kind}, ${b.action}${b.enabled ? '' : ' (off)'}`
const idOf = (args: Record<string, unknown>, key: string) => str(args, key, { max: 64 })

const costCenterTools: Tool[] = [
  {
    name: 'list_cost_centers',
    title: 'List cost centers',
    description: 'Cost centers (departments, projects, clients) jobs can be charged to, and your default. Needs cost centers on.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const list = await listCostCenters(ctx, await workspaceOf(ctx, args))
      const shown = list.costCenters.map((c) => `${c.id} ${c.name}${c.code ? ` (${c.code})` : ''}${c.active ? '' : ', inactive'}${c.id === list.myDefault ? ', your default' : ''}`)
      return output(shown.join('\n') || 'No cost centers yet.', { ...list })
    },
  },
  {
    name: 'create_cost_center',
    title: 'Create cost center',
    description: 'Adds a cost center with a unique name and an optional unique code. Admins only.',
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace({ name: text('Name, e.g. Marketing'), code: nullableText('Code, e.g. MKT-100'), active: bool('Can be chosen; default true') }, ['name']),
    run: async (ctx, args) => {
      const center = await createCostCenter(ctx, await workspaceOf(ctx, args), pick(args, ['name', 'code', 'active']))
      return output(`Created ${center.name} (${center.id}).`, { costCenter: center })
    },
  },
  {
    name: 'update_cost_center',
    title: 'Update cost center',
    description: 'Renames a cost center, changes its code, or turns it off so it can no longer be chosen. Admins only.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ costCenterId: text('Cost center id'), name: text('New name'), code: nullableText('New code; null clears it'), active: bool('Can be chosen') }, ['costCenterId']),
    run: async (ctx, args) => {
      const center = await updateCostCenter(ctx, await workspaceOf(ctx, args), idOf(args, 'costCenterId'), pick(args, ['name', 'code', 'active']))
      return output(`Saved ${center.name}${center.active ? '' : ' (inactive)'}.`, { costCenter: center })
    },
  },
  {
    name: 'delete_cost_center',
    title: 'Delete cost center',
    description: 'Deletes a cost center no job was charged to yet; otherwise set active to false with update_cost_center. Admins only.',
    scope: 'write',
    annotations: REMOVE,
    inputSchema: inWorkspace({ costCenterId: text('Cost center id') }, ['costCenterId']),
    run: async (ctx, args) => {
      const id = idOf(args, 'costCenterId')
      await deleteCostCenter(ctx, await workspaceOf(ctx, args), id)
      return output(`Deleted cost center ${id}.`, { removed: id })
    },
  },
  {
    name: 'set_cost_center_defaults',
    title: 'Set default cost centers',
    description: 'Sets which cost center members, groups and devices are charged to when a job picks none. Merged with the current defaults. Admins only.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ members: ID_MAP('Member (user)'), groups: ID_MAP('Group'), devices: ID_MAP('Device') }),
    run: async (ctx, args) => {
      const defaults = await putDefaults(ctx, await workspaceOf(ctx, args), pick(args, ['members', 'groups', 'devices']))
      const count = Object.values(defaults).reduce((n, m) => n + Object.keys(m).length, 0)
      return output(`${count} defaults set.`, { defaults })
    },
  },
]

const budgetTools: Tool[] = [
  {
    name: 'list_budgets',
    title: 'List budgets',
    description: 'Budgets of every cost center with this cycle’s usage. Admins only.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const budgets = await listBudgets(ctx, await workspaceOf(ctx, args))
      return output(budgets.map(budgetLine).join('\n') || 'No budgets yet.', { budgets })
    },
  },
  {
    name: 'create_budget',
    title: 'Create budget',
    description: 'Adds a budget to a cost center, counting every job charged to it in each cycle. Admins only.',
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace({ costCenterId: text('Cost center id'), ...BUDGET_FIELDS }, ['costCenterId', 'unit', 'amount', 'cycle']),
    run: async (ctx, args) => {
      const budget = await createBudget(ctx, await workspaceOf(ctx, args), pick(args, ['costCenterId', ...Object.keys(BUDGET_FIELDS)]))
      return output(`Created budget ${budgetLine(budget)}.`, { budget })
    },
  },
  {
    name: 'update_budget',
    title: 'Update budget',
    description: 'Changes a budget’s amount, cycle, unit, action, or switch. Admins only.',
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ budgetId: text('Budget id, from list_budgets'), ...BUDGET_FIELDS }, ['budgetId']),
    run: async (ctx, args) => {
      const budget = await updateBudget(ctx, await workspaceOf(ctx, args), idOf(args, 'budgetId'), pick(args, Object.keys(BUDGET_FIELDS)))
      return output(`Saved budget ${budgetLine(budget)}.`, { budget })
    },
  },
  {
    name: 'delete_budget',
    title: 'Delete budget',
    description: 'Deletes a budget. Usage history stays. Admins only.',
    scope: 'write',
    annotations: REMOVE,
    inputSchema: inWorkspace({ budgetId: text('Budget id, from list_budgets') }, ['budgetId']),
    run: async (ctx, args) => {
      const id = idOf(args, 'budgetId')
      await deleteBudget(ctx, await workspaceOf(ctx, args), id)
      return output(`Deleted budget ${id}.`, { removed: id })
    },
  },
]

export const costTools: Tool[] = [...costCenterTools, ...budgetTools]
