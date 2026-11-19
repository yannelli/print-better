import type { LimitAdjustment, PolicySubject, PrintLimit, PrintLimitView } from '../../../shared/policies'
import type { Json } from '../../http/body'
import { badRequest, notFound } from '../../http/errors'
import { nullableStr } from '../../http/validate'
import { newId } from '../../lib/crypto'
import { all, first, run } from '../../lib/db'
import type { Ctx } from '../../services/context'
import { cycleAt } from '../usage/cycles'
import { usageSettings } from '../usage/settings'
import { MAX_MICROS, onlyKeys, wholeNumber } from '../usage/values'
import { changed, enter } from './guard'
import { type LimitFields, parseLimit, scopeColumns } from './limit-values'
import { limitViews } from './limit-views'
import { type LimitRow, toLimit } from './store'
import { parsePolicySubject, requireExisting } from './subjects'

async function limitOf(env: Env, workspaceId: string, id: string): Promise<PrintLimit> {
  const row = await first<LimitRow>(env.DB, 'SELECT * FROM print_limits WHERE id = ? AND workspace_id = ?', id, workspaceId)
  if (!row) throw notFound('Limit not found')
  return toLimit(row)
}

/** `GET /policies/limits`: every limit with this cycle's usage. */
export async function listLimits(ctx: Ctx, workspaceId: string): Promise<PrintLimitView[]> {
  await enter(ctx, workspaceId, 'read', true)
  return limitViews(ctx, workspaceId, 'current')
}

const columns = (f: LimitFields) => [f.name, f.enabled ? 1 : 0, f.exemptAdmins ? 1 : 0, f.scope.type, ...scopeColumns(f.scope), f.unit, f.amount, JSON.stringify(f.cycle), f.action]

export async function createLimit(ctx: Ctx, workspaceId: string, body: Json): Promise<PrintLimit> {
  await enter(ctx, workspaceId, 'write', true)
  const limit = await parseLimit(ctx.env, workspaceId, body)
  const id = newId()
  const now = Date.now()
  await run(
    ctx.env.DB,
    `INSERT INTO print_limits (id, workspace_id, name, enabled, exempt_admins, scope, user_id, group_id, client_id, printer_id, unit, amount, cycle, action, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    workspaceId,
    ...columns(limit),
    now,
    now,
  )
  await changed(ctx, workspaceId, 'limit.create', id, { name: limit.name })
  return limitOf(ctx.env, workspaceId, id)
}

export async function updateLimit(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<PrintLimit> {
  await enter(ctx, workspaceId, 'write', true)
  const limit = await parseLimit(ctx.env, workspaceId, body, await limitOf(ctx.env, workspaceId, id))
  await run(
    ctx.env.DB,
    `UPDATE print_limits SET name = ?, enabled = ?, exempt_admins = ?, scope = ?, user_id = ?, group_id = ?, client_id = ?, printer_id = ?, unit = ?, amount = ?, cycle = ?, action = ?,
       updated_at = ? WHERE id = ? AND workspace_id = ?`,
    ...columns(limit),
    Date.now(),
    id,
    workspaceId,
  )
  await changed(ctx, workspaceId, 'limit.update', id, { fields: Object.keys(body) })
  return limitOf(ctx.env, workspaceId, id)
}

/** Its extra allowances go with it; usage stays recorded. */
export async function deleteLimit(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  await enter(ctx, workspaceId, 'write', true)
  const limit = await limitOf(ctx.env, workspaceId, id)
  await run(ctx.env.DB, 'DELETE FROM print_limits WHERE id = ? AND workspace_id = ?', id, workspaceId)
  await changed(ctx, workspaceId, 'limit.delete', id, { name: limit.name })
}

interface AdjustmentRow {
  id: string
  limit_id: string
  cycle_start: number
  user_id: string | null
  client_id: string | null
  amount: number
  note: string | null
  created_by: string | null
  created_at: number
}

const toAdjustment = (r: AdjustmentRow): LimitAdjustment => ({
  id: r.id,
  limitId: r.limit_id,
  subject: r.user_id ? { type: 'user', id: r.user_id } : r.client_id ? { type: 'client', id: r.client_id } : null,
  amount: r.amount,
  note: r.note,
  cycleStart: r.cycle_start,
  createdBy: r.created_by,
  createdAt: r.created_at,
})

const currentStart = async (ctx: Ctx, workspaceId: string, limit: PrintLimit): Promise<number> =>
  cycleAt(limit.cycle, (await usageSettings(ctx, workspaceId)).timeZone, Date.now()).start

/** `GET /policies/limits/:id/adjustments`: this cycle's extra allowances. */
export async function listAdjustments(ctx: Ctx, workspaceId: string, id: string): Promise<LimitAdjustment[]> {
  await enter(ctx, workspaceId, 'read', true)
  const limit = await limitOf(ctx.env, workspaceId, id)
  const rows = await all<AdjustmentRow>(
    ctx.env.DB,
    'SELECT * FROM limit_adjustments WHERE limit_id = ? AND cycle_start = ? ORDER BY created_at',
    id,
    await currentStart(ctx, workspaceId, limit),
  )
  return rows.map(toAdjustment)
}

/** Whose count an allowance adds to: a member or device for limits that keep one each, nobody for single counts. */
async function allowanceSubject(env: Env, workspaceId: string, limit: PrintLimit, value: unknown): Promise<PolicySubject | null> {
  const types = { 'each-member': ['user'], 'each-device': ['client'], 'group-each': ['user', 'client'] } as const
  const allowed = types[limit.scope.type as keyof typeof types]
  if (!allowed) {
    if (value !== undefined && value !== null) throw badRequest('This limit keeps one count, so leave subject out')
    return null
  }
  if (value === undefined || value === null) throw badRequest('subject is required: whose count gets the extra amount')
  const subject = parsePolicySubject(value, 'subject', allowed)
  await requireExisting(env, workspaceId, { [subject.type]: [subject.id] })
  return subject
}

/** `POST /policies/limits/:id/adjustments`: extra allowance for the current cycle only. */
export async function addAdjustment(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<LimitAdjustment> {
  const { user } = await enter(ctx, workspaceId, 'write', true)
  onlyKeys(body, ['subject', 'amount', 'note'], 'field')
  const limit = await limitOf(ctx.env, workspaceId, id)
  const subject = await allowanceSubject(ctx.env, workspaceId, limit, body.subject)
  const amount = wholeNumber(body.amount, 'amount', 1, MAX_MICROS)
  const row: AdjustmentRow = {
    id: newId(),
    limit_id: id,
    cycle_start: await currentStart(ctx, workspaceId, limit),
    user_id: subject?.type === 'user' ? subject.id : null,
    client_id: subject?.type === 'client' ? subject.id : null,
    amount,
    note: nullableStr(body, 'note', { max: 200 }) ?? null,
    created_by: user.id,
    created_at: Date.now(),
  }
  await run(
    ctx.env.DB,
    `INSERT INTO limit_adjustments (id, workspace_id, limit_id, cycle_start, user_id, client_id, amount, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    workspaceId,
    row.limit_id,
    row.cycle_start,
    row.user_id,
    row.client_id,
    row.amount,
    row.note,
    row.created_by,
    row.created_at,
  )
  await changed(ctx, workspaceId, 'limit.adjust', id, { amount, subject, note: row.note })
  return toAdjustment(row)
}
