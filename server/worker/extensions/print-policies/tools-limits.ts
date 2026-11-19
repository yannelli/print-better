import type { LimitUsage, PrintLimit, PrintLimitView } from '../../../shared/policies'
import { allowancePhrase, idNames, scopePhrase } from '../../../shared/policy-text'
import type { UsageMeter } from '../../../shared/usage'
import { formatAmount, formatLeft } from '../../../shared/usage-text'
import { optStr, str } from '../../http/validate'
import { ACTION, bool, choice, inWorkspace, integer, nullableText, object, output, pick, READ, REMOVE, text, UPDATE, workspaceOf, type Tool } from '../../mcp/tool'
import type { Ctx } from '../../services/context'
import { usageSettings } from '../usage/settings'
import { MAX_MICROS } from '../usage/values'
import { cycleUsage, myUsage } from './limit-views'
import { addAdjustment, createLimit, deleteLimit, listLimits, updateLimit } from './limits'

const SCOPE = object(
  {
    type: choice('each-member, member, group (one shared count), group-each (a count for each member and device), each-device, device, printer, or workspace', [
      'each-member',
      'member',
      'group',
      'group-each',
      'each-device',
      'device',
      'printer',
      'workspace',
    ]),
    id: text('Member user id, group id, device id or printer id, for the scopes that name one'),
  },
  ['type'],
  'Whose printing the limit counts',
)
const CYCLE = object(
  {
    kind: choice('When the count starts over, at midnight in the workspace time zone', ['day', 'week', 'month', 'quarter', 'year']),
    firstDay: integer('For week: the first day, 0 is Sunday', 0, 6),
    startDay: integer('For month: the day it starts', 1, 28),
    startMonth: integer('For quarter and year: the month it starts', 1, 12),
  },
  ['kind'],
)
const LIMIT_FIELDS = {
  name: text('Limit name'),
  enabled: bool('On or off; new limits are on'),
  exemptAdmins: bool("True: doesn't apply to owners and admins"),
  scope: SCOPE,
  unit: choice('pages (printed sides times copies), sheets, jobs, or cost', ['pages', 'sheets', 'jobs', 'cost']),
  amount: integer('How much each cycle; micros for cost, so 10000000 is 10.00', 0, MAX_MICROS),
  cycle: CYCLE,
  action: choice('When a job would go over: block (default), warn, or approval (needs Enterprise controls, otherwise blocks)', ['block', 'warn', 'approval']),
}
const LIMIT_ID = text('Limit id, from list_print_limits')
const limitIdOf = (args: Record<string, unknown>) => str(args, 'limitId', { max: 64 })
const NEEDS = 'Needs Print rules and limits. Admins and owners only.'

const currencyOf = async (ctx: Ctx, workspaceId: string) => (await usageSettings(ctx, workspaceId)).currency
const limitLine = (l: PrintLimit, currency: string) => `${l.name} (${l.id})${l.enabled ? '' : ', off'}: ${scopePhrase(l.scope, idNames)}, ${allowancePhrase(l, currency, 'en-US')}`
const resets = (m: UsageMeter) => new Date(m.end).toISOString()
const countLine = (u: LimitUsage, currency: string) =>
  `  ${u.subjectName ?? (u.subject ? idNames(u.subject.type, u.subject.id) : 'Shared')}: ${formatAmount(u.unit, u.used, currency, 'en-US')} used, ${formatLeft(u.unit, u.left, u.amount, currency, 'en-US')} left`
const viewLines = (views: PrintLimitView[], currency: string) =>
  views.length ? views.flatMap((v) => [limitLine(v, currency), ...v.usage.map((u) => countLine(u, currency))]).join('\n') : 'No limits yet.'

export const limitTools: Tool[] = [
  {
    name: 'list_print_limits',
    title: 'List print limits',
    description: `Print limits with this cycle's usage for each count. ${NEEDS}`,
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const ws = await workspaceOf(ctx, args)
      const limits = await listLimits(ctx, ws)
      return output(viewLines(limits, await currencyOf(ctx, ws)), { limits })
    },
  },
  {
    name: 'create_print_limit',
    title: 'Create print limit',
    description: `Caps how much a member, group, device, printer or the workspace prints each cycle, for example 500 pages a month for each member. ${NEEDS}`,
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace(LIMIT_FIELDS, ['name', 'scope', 'unit', 'amount', 'cycle']),
    run: async (ctx, args) => {
      const ws = await workspaceOf(ctx, args)
      const limit = await createLimit(ctx, ws, pick(args, Object.keys(LIMIT_FIELDS)))
      return output(`Created ${limitLine(limit, await currencyOf(ctx, ws))}.`, { limit })
    },
  },
  {
    name: 'update_print_limit',
    title: 'Update print limit',
    description: `Changes a limit; fields left out stay. ${NEEDS}`,
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ limitId: LIMIT_ID, ...LIMIT_FIELDS }, ['limitId']),
    run: async (ctx, args) => {
      const ws = await workspaceOf(ctx, args)
      const limit = await updateLimit(ctx, ws, limitIdOf(args), pick(args, Object.keys(LIMIT_FIELDS)))
      return output(`Updated ${limitLine(limit, await currencyOf(ctx, ws))}.`, { limit })
    },
  },
  {
    name: 'delete_print_limit',
    title: 'Delete print limit',
    description: `Deletes a limit and its extra allowances. What was printed stays recorded. ${NEEDS}`,
    scope: 'write',
    annotations: REMOVE,
    inputSchema: inWorkspace({ limitId: LIMIT_ID }, ['limitId']),
    run: async (ctx, args) => {
      const id = limitIdOf(args)
      await deleteLimit(ctx, await workspaceOf(ctx, args), id)
      return output(`Deleted limit ${id}.`, { removed: id })
    },
  },
  {
    name: 'add_limit_allowance',
    title: 'Add limit allowance',
    description: `Gives a one-off extra amount for the current cycle only, for example 100 more pages for one member this month. ${NEEDS}`,
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace(
      {
        limitId: LIMIT_ID,
        amount: integer("Extra amount in the limit's unit; micros for cost", 1, MAX_MICROS),
        subject: object(
          { type: choice('A member (user) or a device (client)', ['user', 'client']), id: text('Member user id or device id') },
          ['type', 'id'],
          'Whose count, for each-member, each-device and group-each limits; leave out for a shared count',
        ),
        note: nullableText('Why, for the record'),
      },
      ['limitId', 'amount'],
    ),
    run: async (ctx, args) => {
      const ws = await workspaceOf(ctx, args)
      const adjustment = await addAdjustment(ctx, ws, limitIdOf(args), pick(args, ['amount', 'subject', 'note']))
      return output(`Added ${adjustment.amount} to limit ${adjustment.limitId} for this cycle.`, { adjustment })
    },
  },
  {
    name: 'get_my_usage',
    title: 'Get my usage',
    description: 'The limits that count your print jobs in a workspace: used, left, and when each starts over. Needs Print rules and limits.',
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const ws = await workspaceOf(ctx, args)
      const usage = await myUsage(ctx, ws)
      const currency = await currencyOf(ctx, ws)
      const lines = usage.limits.map((l) => `${l.name}: ${formatLeft(l.unit, l.left, l.amount, currency, 'en-US')} left, starts over ${resets(l)}`)
      return output(lines.length ? lines.join('\n') : 'No limits count your jobs.', { usage })
    },
  },
  {
    name: 'get_usage',
    title: 'Get usage',
    description: `Every limit's counts in the current or the previous cycle. ${NEEDS}`,
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace({ cycle: choice('current (default) or previous', ['current', 'previous']) }),
    run: async (ctx, args) => {
      const ws = await workspaceOf(ctx, args)
      const limits = await cycleUsage(ctx, ws, optStr(args, 'cycle', { max: 16 }) ?? null)
      return output(viewLines(limits, await currencyOf(ctx, ws)), { limits })
    },
  },
]
