import type { LimitScope, PrintLimit } from '../../../shared/policies'
import type { UsageMeter, UsageUnit } from '../../../shared/usage'
import { type SqlValue, stmt } from '../../lib/db'
import type { WriteGuard } from '../hooks'
import type { CycleSpan } from '../usage/cycles'

/** Whose count, for limits that keep one per member or device. */
export interface Whose {
  type: 'user' | 'client'
  id: string
}

/** One count of a limit in one cycle; `whose` is null when the limit keeps a single count. */
export interface Count {
  limit: PrintLimit
  span: CycleSpan
  whose: Whose | null
}

/** Who sends a job, as limits see them. */
export interface LimitSender {
  userId: string | null
  clientId: string | null
  groups: readonly string[]
}

/** The count a job from `sender` lands in, or null when the limit doesn't count it. `onPrinter` says whether it goes to that printer. */
export function countOf(limit: PrintLimit, sender: LimitSender, onPrinter: (id: string) => boolean): { whose: Whose | null } | null {
  const { scope } = limit
  const own: Whose | null = sender.userId ? { type: 'user', id: sender.userId } : sender.clientId ? { type: 'client', id: sender.clientId } : null
  switch (scope.type) {
    case 'each-member':
      return sender.userId ? { whose: { type: 'user', id: sender.userId } } : null
    case 'each-device':
      return sender.clientId ? { whose: { type: 'client', id: sender.clientId } } : null
    case 'group-each':
      return own && sender.groups.includes(scope.id) ? { whose: own } : null
    case 'member':
      return sender.userId === scope.id ? { whose: null } : null
    case 'device':
      return sender.clientId === scope.id ? { whose: null } : null
    case 'group':
      return sender.groups.includes(scope.id) ? { whose: null } : null
    case 'printer':
      return onPrinter(scope.id) ? { whose: null } : null
    case 'workspace':
      return { whose: null }
  }
}

export const COLUMN: Record<UsageUnit, string> = { pages: 'pages', sheets: 'sheets', jobs: 'jobs', cost: 'cost_micros' }

const IN_GROUP = `(user_id IN (SELECT user_id FROM group_members WHERE group_id = ? AND user_id IS NOT NULL)
  OR client_id IN (SELECT client_id FROM group_members WHERE group_id = ? AND client_id IS NOT NULL))`

/** The usage entries a single count adds up. */
export function countFilter(scope: LimitScope, whose: Whose | null): [string, SqlValue[]] {
  if (whose) return [whose.type === 'user' ? 'user_id = ?' : 'client_id = ?', [whose.id]]
  switch (scope.type) {
    case 'member':
      return ['user_id = ?', [scope.id]]
    case 'device':
      return ['client_id = ?', [scope.id]]
    case 'printer':
      return ['printer_id = ?', [scope.id]]
    case 'group':
      return [IN_GROUP, [scope.id, scope.id]]
    default:
      return ['1 = 1', []]
  }
}

function usedSql(workspaceId: string, c: Count): [string, SqlValue[]] {
  const [where, params] = countFilter(c.limit.scope, c.whose)
  const sql = `SELECT COALESCE(SUM(${COLUMN[c.limit.unit]}), 0) AS used FROM usage_entries WHERE workspace_id = ? AND at >= ? AND at < ? AND ${where}`
  return [sql, [workspaceId, c.span.start, c.span.end, ...params]]
}

export function usedStatement(env: Env, workspaceId: string, c: Count): D1PreparedStatement {
  const [sql, params] = usedSql(workspaceId, c)
  return stmt(env.DB, sql, ...params)
}

/** The count still has room for `need` within `amount`, when the job is stored. */
export function roomFor(workspaceId: string, c: Count, need: number, amount: number): WriteGuard {
  const [sql, params] = usedSql(workspaceId, c)
  return { sql: `(${sql}) + ? <= ?`, params: [...params, need, amount] }
}

export interface AllowanceRow {
  limit_id: string
  cycle_start: number
  user_id: string | null
  client_id: string | null
  amount: number
}

export const allowanceStatement = (env: Env, workspaceId: string, limitIds: string[], since: number): D1PreparedStatement =>
  stmt(
    env.DB,
    'SELECT limit_id, cycle_start, user_id, client_id, amount FROM limit_adjustments WHERE workspace_id = ? AND limit_id IN (SELECT value FROM json_each(?)) AND cycle_start >= ?',
    workspaceId,
    JSON.stringify(limitIds),
    since,
  )

/** Extra allowance given to this count for its cycle: any that started within it, so a new time zone or cycle keeps it. */
export function extraFor(rows: readonly AllowanceRow[], c: Count): number {
  const mine = (r: AllowanceRow) => (c.whose ? (c.whose.type === 'user' ? r.user_id : r.client_id) === c.whose.id : r.user_id === null && r.client_id === null)
  const current = (r: AllowanceRow) => r.cycle_start >= c.span.start && r.cycle_start < c.span.end
  return rows.filter((r) => r.limit_id === c.limit.id && current(r) && mine(r)).reduce((sum, r) => sum + r.amount, 0)
}

export function meterOf(c: Count, used: number, extra: number): UsageMeter {
  const amount = c.limit.amount + extra
  return { unit: c.limit.unit, used, amount, left: amount - used, start: c.span.start, end: c.span.end }
}

/** Each count's meter, in one round trip. */
export async function measure(env: Env, workspaceId: string, counts: readonly Count[]): Promise<UsageMeter[]> {
  if (counts.length === 0) return []
  const since = Math.min(...counts.map((c) => c.span.start))
  const ids = [...new Set(counts.map((c) => c.limit.id))]
  const results = await env.DB.batch([...counts.map((c) => usedStatement(env, workspaceId, c)), allowanceStatement(env, workspaceId, ids, since)])
  const allowances = results[counts.length].results as AllowanceRow[]
  return counts.map((c, i) => meterOf(c, (results[i].results[0] as { used: number }).used, extraFor(allowances, c)))
}
