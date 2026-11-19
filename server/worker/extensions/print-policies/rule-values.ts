import type { FileKind, PolicySubject, RuleAction, RuleConditions } from '../../../shared/policies'
import type { Json } from '../../http/body'
import { badRequest } from '../../http/errors'
import { isObj, optBool, str } from '../../http/validate'
import { objectOf, onlyKeys, wholeNumber } from '../usage/values'
import { parsePolicySubject, requireExisting } from './subjects'

const SOURCES = ['web', 'api', 'mcp', 'email', 'device', 'test'] as const
const FILE_KINDS: readonly FileKind[] = ['pdf', 'image', 'text']
const CONDITION_KEYS = ['who', 'sources', 'printers', 'pages', 'minCopies', 'color', 'sides', 'fileKinds', 'minSizeMb', 'time']
const ACTION_KEYS: Record<RuleAction['type'], string[]> = {
  block: ['type', 'message'],
  'two-sided': ['type'],
  monochrome: ['type'],
  'max-copies': ['type', 'copies'],
  redirect: ['type', 'printerId'],
  approval: ['type'],
  release: ['type'],
  note: ['type', 'message'],
}
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/
export const MAX_PAGES = 1_000_000

function listOf<T>(value: unknown, path: string, item: (v: unknown, path: string) => T, max = 100): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw badRequest(`${path} must be a list of 1 to ${max} items`)
  return value.map((v, i) => item(v, `${path}[${i}]`))
}

const unique = <T>(items: T[]): T[] => [...new Set(items)]

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown, path: string): T => {
    if (!values.includes(v as T)) throw badRequest(`${path} must be one of: ${values.join(', ')}`)
    return v as T
  }

function idOf(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 64) throw badRequest(`${path} must be an id`)
  return v.trim()
}

function textOf(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 200) throw badRequest(`${path} must be text of 1 to 200 characters`)
  return v.trim()
}

function boolOf(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw badRequest(`${path} must be true or false`)
  return v
}

function pagesOf(value: unknown): { min?: number; max?: number } {
  const o = objectOf(value, 'conditions.pages', ['min', 'max'])
  const min = o.min === undefined ? undefined : wholeNumber(o.min, 'conditions.pages.min', 1, MAX_PAGES)
  const max = o.max === undefined ? undefined : wholeNumber(o.max, 'conditions.pages.max', 1, MAX_PAGES)
  if (min === undefined && max === undefined) throw badRequest('conditions.pages needs min, max, or both')
  if (min !== undefined && max !== undefined && min > max) throw badRequest('conditions.pages.min must not be more than max')
  return { ...(min !== undefined && { min }), ...(max !== undefined && { max }) }
}

function timeOf(value: unknown): NonNullable<RuleConditions['time']> {
  const o = objectOf(value, 'conditions.time', ['days', 'from', 'to'])
  const days = unique(listOf(o.days, 'conditions.time.days', (v, p) => wholeNumber(v, p, 0, 6), 7)).sort()
  const [from, to] = (['from', 'to'] as const).map((k) => {
    if (typeof o[k] !== 'string' || !HH_MM.test(o[k] as string)) throw badRequest(`conditions.time.${k} must be a time such as 08:30`)
    return o[k] as string
  })
  return { days, from, to }
}

export function parseConditions(value: unknown): RuleConditions {
  const o = objectOf(value, 'conditions', CONDITION_KEYS)
  const c: RuleConditions = {}
  if (o.who !== undefined) c.who = listOf(o.who, 'conditions.who', (v, p) => parsePolicySubject(v, p))
  if (o.sources !== undefined) c.sources = unique(listOf(o.sources, 'conditions.sources', oneOf(SOURCES)))
  if (o.printers !== undefined) c.printers = unique(listOf(o.printers, 'conditions.printers', idOf))
  if (o.pages !== undefined) c.pages = pagesOf(o.pages)
  if (o.minCopies !== undefined) c.minCopies = wholeNumber(o.minCopies, 'conditions.minCopies', 1, 999)
  if (o.color !== undefined) c.color = boolOf(o.color, 'conditions.color')
  if (o.sides !== undefined) c.sides = oneOf(['one-sided', 'two-sided'] as const)(o.sides, 'conditions.sides')
  if (o.fileKinds !== undefined) c.fileKinds = unique(listOf(o.fileKinds, 'conditions.fileKinds', oneOf(FILE_KINDS)))
  if (o.minSizeMb !== undefined) {
    if (typeof o.minSizeMb !== 'number' || !(o.minSizeMb > 0) || o.minSizeMb > 1000) throw badRequest('conditions.minSizeMb must be a number of megabytes above 0')
    c.minSizeMb = o.minSizeMb
  }
  if (o.time !== undefined) c.time = timeOf(o.time)
  return c
}

function actionOf(v: unknown, path: string): RuleAction {
  if (!isObj(v) || typeof v.type !== 'string' || !(v.type in ACTION_KEYS)) throw badRequest(`${path}.type must be one of: ${Object.keys(ACTION_KEYS).join(', ')}`)
  const type = v.type as RuleAction['type']
  onlyKeys(v, ACTION_KEYS[type], `key in ${path}`)
  switch (type) {
    case 'block':
    case 'note':
      return { type, message: textOf(v.message, `${path}.message`) }
    case 'max-copies':
      return { type, copies: wholeNumber(v.copies, `${path}.copies`, 1, 999) }
    case 'redirect':
      return { type, printerId: idOf(v.printerId, `${path}.printerId`) }
    default:
      return { type }
  }
}

export const parseActions = (value: unknown): RuleAction[] => listOf(value, 'actions', actionOf, 10)

export interface RuleFields {
  name: string
  enabled: boolean
  exemptAdmins: boolean
  conditions: RuleConditions
  actions: RuleAction[]
}

const who = (c: RuleConditions, type: PolicySubject['type']) => (c.who ?? []).filter((s) => s.type === type).map((s) => s.id)

/** A new rule (`current` undefined) or changes to one. Ids named in what changed must exist. */
export async function parseRule(env: Env, workspaceId: string, body: Json, current?: RuleFields): Promise<RuleFields> {
  onlyKeys(body, ['name', 'enabled', 'exemptAdmins', 'conditions', 'actions'], 'field')
  const conditions = body.conditions === undefined ? (current?.conditions ?? {}) : parseConditions(body.conditions)
  const actions = body.actions === undefined && current ? current.actions : parseActions(body.actions)
  const newConditions = body.conditions === undefined ? {} : conditions
  const newActions = body.actions === undefined ? [] : actions
  await requireExisting(env, workspaceId, {
    user: who(newConditions, 'user'),
    group: who(newConditions, 'group'),
    client: who(newConditions, 'client'),
    printer: [...(newConditions.printers ?? []), ...newActions.flatMap((a) => (a.type === 'redirect' ? [a.printerId] : []))],
  })
  return {
    name: body.name === undefined && current ? current.name : str(body, 'name', { max: 100 }),
    enabled: optBool(body, 'enabled') ?? current?.enabled ?? true,
    exemptAdmins: optBool(body, 'exemptAdmins') ?? current?.exemptAdmins ?? false,
    conditions,
    actions,
  }
}
