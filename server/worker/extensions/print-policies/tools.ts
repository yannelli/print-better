import type { PrintRule } from '../../../shared/policies'
import { actionPhrase, conditionPhrases, idNames } from '../../../shared/policy-text'
import { str } from '../../http/validate'
import { ACTION, bool, choice, inWorkspace, integer, object, output, pick, READ, REMOVE, text, UPDATE, workspaceOf, type Schema, type Tool } from '../../mcp/tool'
import { createRule, deleteRule, listRules, reorderRules, updateRule } from './rules'
import { limitTools } from './tools-limits'

const ids = (description: string): Schema => ({ type: 'array', items: { type: 'string' }, description })
const SUBJECTS: Schema = {
  type: 'array',
  description: 'Members (user), groups (group, needs Printer access) or devices (client) the job is from',
  items: object({ type: choice('Kind', ['user', 'group', 'client']), id: text('Member user id, group id or device id') }, ['type', 'id']),
}
const CONDITIONS = object(
  {
    who: SUBJECTS,
    sources: { type: 'array', items: { type: 'string', enum: ['web', 'api', 'mcp', 'email', 'device', 'test'] }, description: 'Where the job came from' },
    printers: ids('Printer ids the job goes to'),
    pages: object({ min: integer('At least', 1, 1_000_000), max: integer('At most', 1, 1_000_000) }, [], 'Total pages: pages in the chosen ranges times copies'),
    minCopies: integer('At least this many copies', 1, 999),
    color: bool('True: prints in color; false: in black and white'),
    sides: choice('What the job asks for', ['one-sided', 'two-sided']),
    fileKinds: { type: 'array', items: { type: 'string', enum: ['pdf', 'image', 'text'] }, description: 'Kinds of file' },
    minSizeMb: { type: 'number', description: 'Files of at least this many MB', exclusiveMinimum: 0, maximum: 1000 },
    time: object(
      { days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: '0 is Sunday' }, from: text('HH:MM'), to: text('HH:MM; earlier than from crosses midnight, equal to from is all day') },
      ['days', 'from', 'to'],
      'When the job is sent, in the workspace time zone',
    ),
  },
  [],
  'Every condition set must match; none matches every job',
)
const ACTIONS: Schema = {
  type: 'array',
  minItems: 1,
  maxItems: 10,
  description: 'What the rule does, in order',
  items: object(
    {
      type: choice('block, two-sided, monochrome, max-copies, redirect, approval and release (need Enterprise controls), or note', [
        'block',
        'two-sided',
        'monochrome',
        'max-copies',
        'redirect',
        'approval',
        'release',
        'note',
      ]),
      message: text('For block and note: what the sender sees'),
      copies: integer('For max-copies', 1, 999),
      printerId: text('For redirect: the printer to send the job to'),
    },
    ['type'],
  ),
}
const RULE_FIELDS = {
  name: text('Rule name'),
  enabled: bool('On or off; new rules are on'),
  exemptAdmins: bool("True: doesn't apply to owners and admins"),
  conditions: CONDITIONS,
  actions: ACTIONS,
}
const RULE_ID = text('Rule id, from list_print_rules')
const ruleIdOf = (args: Record<string, unknown>) => str(args, 'ruleId', { max: 64 })
const NEEDS = 'Needs Print rules and limits. Admins and owners only.'

function ruleLine(r: PrintRule): string {
  const when = conditionPhrases(r.conditions, idNames)
  return `${r.name} (${r.id})${r.enabled ? '' : ', off'}: ${when.length ? when.join('; ') : 'every job'}. Then: ${r.actions.map((a) => actionPhrase(a, idNames)).join('; ')}.`
}

const ruleList = (rules: PrintRule[]) => (rules.length ? rules.map((r, i) => `${i + 1}. ${ruleLine(r)}`).join('\n') : 'No rules yet.')

const ruleTools: Tool[] = [
  {
    name: 'list_print_rules',
    title: 'List print rules',
    description: `Print rules, top to bottom, the order they run in. ${NEEDS}`,
    scope: 'read',
    annotations: READ,
    inputSchema: inWorkspace(),
    run: async (ctx, args) => {
      const rules = await listRules(ctx, await workspaceOf(ctx, args))
      return output(ruleList(rules), { rules })
    },
  },
  {
    name: 'create_print_rule',
    title: 'Create print rule',
    description: `Adds a rule at the bottom. Rules check every job before it is queued: a matching rule can block it, print it two-sided or in black and white, limit copies, send it to another printer, or add a note. ${NEEDS}`,
    scope: 'write',
    annotations: ACTION,
    inputSchema: inWorkspace(RULE_FIELDS, ['name', 'actions']),
    run: async (ctx, args) => {
      const rule = await createRule(ctx, await workspaceOf(ctx, args), pick(args, Object.keys(RULE_FIELDS)))
      return output(`Created ${ruleLine(rule)}`, { rule })
    },
  },
  {
    name: 'update_print_rule',
    title: 'Update print rule',
    description: `Changes a rule's name, switch, conditions or actions; fields left out stay. ${NEEDS}`,
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ ruleId: RULE_ID, ...RULE_FIELDS }, ['ruleId']),
    run: async (ctx, args) => {
      const rule = await updateRule(ctx, await workspaceOf(ctx, args), ruleIdOf(args), pick(args, Object.keys(RULE_FIELDS)))
      return output(`Updated ${ruleLine(rule)}`, { rule })
    },
  },
  {
    name: 'delete_print_rule',
    title: 'Delete print rule',
    description: `Deletes a rule. ${NEEDS}`,
    scope: 'write',
    annotations: REMOVE,
    inputSchema: inWorkspace({ ruleId: RULE_ID }, ['ruleId']),
    run: async (ctx, args) => {
      const id = ruleIdOf(args)
      await deleteRule(ctx, await workspaceOf(ctx, args), id)
      return output(`Deleted rule ${id}.`, { removed: id })
    },
  },
  {
    name: 'reorder_print_rules',
    title: 'Reorder print rules',
    description: `Sets the order rules run in. List every rule id once, top to bottom. ${NEEDS}`,
    scope: 'write',
    annotations: UPDATE,
    inputSchema: inWorkspace({ ids: ids('Every rule id, top to bottom') }, ['ids']),
    run: async (ctx, args) => {
      const rules = await reorderRules(ctx, await workspaceOf(ctx, args), pick(args, ['ids']))
      return output(ruleList(rules), { rules })
    },
  },
]

export const printPolicyTools: Tool[] = [...ruleTools, ...limitTools]
