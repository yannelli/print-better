import type { LimitScope, LimitUsage, MyUsage, PolicySubject, PrintLimit, PrintLimitView } from '../../../shared/policies'
import type { Role } from '../../../shared/types'
import { badRequest } from '../../http/errors'
import { stmt } from '../../lib/db'
import type { Ctx } from '../../services/context'
import { groupsOf } from '../usage/check'
import { type CycleSpan, cycleAt, previousCycle } from '../usage/cycles'
import { usageSettings } from '../usage/settings'
import { enter } from './guard'
import { type AllowanceRow, allowanceStatement, COLUMN, type Count, countOf, extraFor, measure, meterOf, usedStatement } from './meters'
import { loadLimits } from './store'

type Column = 'user_id' | 'client_id'
type Named = { id: string; name: string }

interface People {
  members: (Named & { role: Role })[]
  clients: Named[]
  groupMembers: { group_id: string; user_id: string | null; client_id: string | null }[]
}

/** Limits that keep a count per member or device, and where those counts come from. */
const PER_SUBJECT: Partial<Record<LimitScope['type'], Column[]>> = { 'each-member': ['user_id'], 'each-device': ['client_id'], 'group-each': ['user_id', 'client_id'] }

type Labeled = Count & { subject: PolicySubject | null; subjectName: string | null }

/** Every count a limit keeps in `span`, named for display. */
function countsOf(limit: PrintLimit, span: CycleSpan, people: People): Labeled[] {
  const user = (m: Named): Labeled => ({ limit, span, whose: { type: 'user', id: m.id }, subject: { type: 'user', id: m.id }, subjectName: m.name })
  const client = (c: Named): Labeled => ({ limit, span, whose: { type: 'client', id: c.id }, subject: { type: 'client', id: c.id }, subjectName: c.name })
  const { scope } = limit
  switch (scope.type) {
    case 'each-member':
      return people.members.filter((m) => !(limit.exemptAdmins && m.role !== 'member')).map(user)
    case 'each-device':
      return people.clients.map(client)
    case 'group-each': {
      const inGroup = people.groupMembers.filter((g) => g.group_id === scope.id)
      return [...people.members.filter((m) => inGroup.some((g) => g.user_id === m.id)).map(user), ...people.clients.filter((c) => inGroup.some((g) => g.client_id === c.id)).map(client)]
    }
    case 'member':
      return [{ limit, span, whose: null, subject: { type: 'user', id: scope.id }, subjectName: people.members.find((m) => m.id === scope.id)?.name ?? null }]
    case 'device':
      return [{ limit, span, whose: null, subject: { type: 'client', id: scope.id }, subjectName: people.clients.find((c) => c.id === scope.id)?.name ?? null }]
    default:
      return [{ limit, span, whose: null, subject: null, subjectName: null }]
  }
}

const usedBy = (env: Env, workspaceId: string, limit: PrintLimit, span: CycleSpan, column: Column) =>
  stmt(
    env.DB,
    `SELECT ${column} AS id, COALESCE(SUM(${COLUMN[limit.unit]}), 0) AS used FROM usage_entries
     WHERE workspace_id = ? AND at >= ? AND at < ? AND ${column} IS NOT NULL GROUP BY ${column}`,
    workspaceId,
    span.start,
    span.end,
  )

/** Every limit with its counts in the current or the previous cycle, in one round trip. */
export async function limitViews(ctx: Ctx, workspaceId: string, which: 'current' | 'previous'): Promise<PrintLimitView[]> {
  const env = ctx.env
  const [limits, { timeZone }] = await Promise.all([loadLimits(env, workspaceId), usageSettings(ctx, workspaceId)])
  if (limits.length === 0) return []
  const now = Date.now()
  const spans = limits.map((l) => (which === 'current' ? cycleAt(l.cycle, timeZone, now) : previousCycle(l.cycle, timeZone, now)))
  const plans = limits.map((limit, i) => PER_SUBJECT[limit.scope.type]?.map((column) => ({ column, statement: usedBy(env, workspaceId, limit, spans[i], column) })) ?? [
    { column: null, statement: usedStatement(env, workspaceId, { limit, span: spans[i], whose: null }) },
  ])
  const results = await env.DB.batch([
    stmt(env.DB, 'SELECT m.user_id AS id, u.name, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY u.name', workspaceId),
    stmt(env.DB, 'SELECT id, name FROM clients WHERE workspace_id = ? ORDER BY name', workspaceId),
    stmt(env.DB, 'SELECT group_id, user_id, client_id FROM group_members WHERE workspace_id = ?', workspaceId),
    allowanceStatement(env, workspaceId, limits.map((l) => l.id), Math.min(...spans.map((s) => s.start))),
    ...plans.flat().map((p) => p.statement),
  ])
  const [members, clients, groupMembers, allowances] = results.slice(0, 4).map((r) => r.results)
  const people = { members, clients, groupMembers } as People
  let next = 4
  return limits.map((limit, i) => {
    const used = new Map<string | null, Map<string, number> | number>()
    for (const plan of plans[i]) {
      const rows = results[next++].results as { id?: string; used: number }[]
      used.set(plan.column, plan.column ? new Map(rows.map((r) => [r.id as string, r.used])) : rows[0].used)
    }
    const usage: LimitUsage[] = countsOf(limit, spans[i], people).map((c) => {
      const source = used.get(c.whose ? (c.whose.type === 'user' ? 'user_id' : 'client_id') : null)
      const value = typeof source === 'number' ? source : (source?.get(c.whose?.id ?? '') ?? 0)
      return { ...meterOf(c, value, extraFor(allowances as AllowanceRow[], c)), subject: c.subject, subjectName: c.subjectName }
    })
    usage.sort((a, b) => b.used - a.used || (a.subjectName ?? '').localeCompare(b.subjectName ?? ''))
    return { ...limit, usage }
  })
}

/** `GET /usage?cycle=current|previous` (admins). */
export async function cycleUsage(ctx: Ctx, workspaceId: string, cycle: string | null): Promise<PrintLimitView[]> {
  await enter(ctx, workspaceId, 'read', true)
  if (cycle !== null && cycle !== 'current' && cycle !== 'previous') throw badRequest('cycle must be current or previous')
  return limitViews(ctx, workspaceId, cycle ?? 'current')
}

/** `GET /usage/me`: the limits that count the caller's jobs on any printer they can see, with what is left. */
export async function myUsage(ctx: Ctx, workspaceId: string): Promise<MyUsage> {
  const { user, role, access } = await enter(ctx, workspaceId, 'read')
  const sender = { userId: user.id, clientId: null }
  const [limits, { timeZone }, groups] = await Promise.all([loadLimits(ctx.env, workspaceId), usageSettings(ctx, workspaceId), groupsOf(ctx, workspaceId, sender)])
  const admin = role !== 'member'
  const now = Date.now()
  const counts: Count[] = limits.flatMap((limit) => {
    const found = limit.enabled && !(limit.exemptAdmins && admin) ? countOf(limit, { ...sender, groups }, (id) => access.can(id, 'view')) : null
    return found ? [{ limit, whose: found.whose, span: cycleAt(limit.cycle, timeZone, now) }] : []
  })
  const meters = await measure(ctx.env, workspaceId, counts)
  return { limits: counts.map(({ limit }, i) => ({ id: limit.id, name: limit.name, scope: limit.scope, action: limit.action, ...meters[i] })) }
}
