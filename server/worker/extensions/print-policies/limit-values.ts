import type { LimitScope } from '../../../shared/policies'
import type { Cycle, OverAction, UsageUnit } from '../../../shared/usage'
import type { Json } from '../../http/body'
import { badRequest } from '../../http/errors'
import { isObj, optBool, str } from '../../http/validate'
import { MAX_MICROS, objectOf, onlyKeys, wholeNumber } from '../usage/values'
import { requireExisting } from './subjects'

const UNITS: readonly UsageUnit[] = ['pages', 'sheets', 'jobs', 'cost']
const ACTIONS: readonly OverAction[] = ['block', 'warn', 'approval']
const SHARED_SCOPES = ['each-member', 'each-device', 'workspace'] as const
const NAMED_SCOPES = { member: 'user', group: 'group', 'group-each': 'group', device: 'client', printer: 'printer' } as const

function scopeOf(value: unknown): LimitScope {
  if (!isObj(value) || typeof value.type !== 'string') throw badRequest('scope must be { "type": … }')
  if ((SHARED_SCOPES as readonly string[]).includes(value.type)) {
    onlyKeys(value, ['type'], 'key in scope')
    return { type: value.type as (typeof SHARED_SCOPES)[number] }
  }
  if (!(value.type in NAMED_SCOPES)) throw badRequest(`scope.type must be one of: ${[...SHARED_SCOPES, ...Object.keys(NAMED_SCOPES)].join(', ')}`)
  onlyKeys(value, ['type', 'id'], 'key in scope')
  if (typeof value.id !== 'string' || !value.id.trim()) throw badRequest('scope.id is required for this scope')
  return { type: value.type as keyof typeof NAMED_SCOPES, id: value.id.trim() }
}

function cycleOf(value: unknown): Cycle {
  if (!isObj(value) || typeof value.kind !== 'string') throw badRequest('cycle must be { "kind": "day" | "week" | "month" | "quarter" | "year", … }')
  switch (value.kind) {
    case 'day':
      objectOf(value, 'cycle', ['kind'])
      return { kind: 'day' }
    case 'week':
      objectOf(value, 'cycle', ['kind', 'firstDay'])
      return { kind: 'week', firstDay: wholeNumber(value.firstDay, 'cycle.firstDay', 0, 6) }
    case 'month':
      objectOf(value, 'cycle', ['kind', 'startDay'])
      return { kind: 'month', startDay: wholeNumber(value.startDay, 'cycle.startDay', 1, 28) }
    case 'quarter':
    case 'year':
      objectOf(value, 'cycle', ['kind', 'startMonth'])
      return { kind: value.kind, startMonth: wholeNumber(value.startMonth, 'cycle.startMonth', 1, 12) }
    default:
      throw badRequest('cycle.kind must be day, week, month, quarter or year')
  }
}

function oneOf<T extends string>(value: unknown, key: string, values: readonly T[]): T {
  if (!values.includes(value as T)) throw badRequest(`${key} must be one of: ${values.join(', ')}`)
  return value as T
}

export interface LimitFields {
  name: string
  enabled: boolean
  exemptAdmins: boolean
  scope: LimitScope
  unit: UsageUnit
  amount: number
  cycle: Cycle
  action: OverAction
}

/** A new limit (`current` undefined) or changes to one. A member, group, device or printer it names must exist. */
export async function parseLimit(env: Env, workspaceId: string, body: Json, current?: LimitFields): Promise<LimitFields> {
  onlyKeys(body, ['name', 'enabled', 'exemptAdmins', 'scope', 'unit', 'amount', 'cycle', 'action'], 'field')
  const given = <T>(key: string, parse: (v: unknown) => T, fallback: T | undefined): T => (body[key] === undefined && fallback !== undefined ? fallback : parse(body[key]))
  const scope = given('scope', scopeOf, current?.scope)
  if (body.scope !== undefined && 'id' in scope) await requireExisting(env, workspaceId, { [NAMED_SCOPES[scope.type]]: [scope.id] })
  return {
    name: body.name === undefined && current ? current.name : str(body, 'name', { max: 100 }),
    enabled: optBool(body, 'enabled') ?? current?.enabled ?? true,
    exemptAdmins: optBool(body, 'exemptAdmins') ?? current?.exemptAdmins ?? false,
    scope,
    unit: given('unit', (v) => oneOf(v, 'unit', UNITS), current?.unit),
    amount: given('amount', (v) => wholeNumber(v, 'amount', 0, MAX_MICROS), current?.amount),
    cycle: given('cycle', cycleOf, current?.cycle),
    action: given('action', (v) => oneOf(v, 'action', ACTIONS), current?.action ?? 'block'),
  }
}

/** The id columns of `print_limits`, one per kind of subject. */
export function scopeColumns(scope: LimitScope): [string | null, string | null, string | null, string | null] {
  const id = 'id' in scope ? scope.id : null
  return [
    scope.type === 'member' ? id : null,
    scope.type === 'group' || scope.type === 'group-each' ? id : null,
    scope.type === 'device' ? id : null,
    scope.type === 'printer' ? id : null,
  ]
}
