import type { ReportSchedule } from '../../../shared/enterprise'
import type { Cycle } from '../../../shared/usage'
import type { Json } from '../../http/body'
import { notFound } from '../../http/errors'
import { str } from '../../http/validate'
import { newId } from '../../lib/crypto'
import { all, first, parseJson, run } from '../../lib/db'
import { HOUR } from '../../lib/time'
import type { Ctx } from '../../services/context'
import { cycleAt, localMidnight, localTime, type LocalDate } from '../usage/cycles'
import { usageSettings } from '../usage/settings'
import { changed, enter } from './guard'
import { parseDimension } from './reports'
import { memberIds, onlyKeys, parseCycle } from './values'

export interface ScheduleRow {
  id: string
  workspace_id: string
  name: string
  dimension: string
  cycle: string
  recipients: string
  origin: string
  next_run_at: number
  last_run_at: number | null
  created_at: number
}

export const toSchedule = (r: ScheduleRow): ReportSchedule => ({
  id: r.id,
  name: r.name,
  by: parseDimension(r.dimension),
  cycle: parseJson<ReportSchedule['cycle']>(r.cycle, { kind: 'month', startDay: 1 }),
  recipients: parseJson<string[]>(r.recipients, []),
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  createdAt: r.created_at,
})

const dateAt = (timeZone: string, at: number): LocalDate => {
  const t = localTime(timeZone, at)
  return { year: t.year, month: t.month, day: t.day }
}

/** 08:00 local on `date`, also on days when clocks change. */
function eightAm(timeZone: string, date: LocalDate): number {
  const guess = localMidnight(timeZone, date) + 8 * HOUR
  return guess + (8 - localTime(timeZone, guess).hour) * HOUR
}

/** The next 08:00 on the first day of a cycle, after `after`. */
export function nextRun(cycle: Cycle, timeZone: string, after: number): number {
  const span = cycleAt(cycle, timeZone, after)
  const first = eightAm(timeZone, dateAt(timeZone, span.start))
  return first > after ? first : eightAm(timeZone, dateAt(timeZone, span.end))
}

/** The cycle that ended just before a run: `from` and `to` as local dates. */
export function coveredBy(cycle: Cycle, timeZone: string, runAt: number): { from: LocalDate; to: LocalDate } {
  const span = cycleAt(cycle, timeZone, cycleAt(cycle, timeZone, runAt).start - 1)
  return { from: dateAt(timeZone, span.start), to: dateAt(timeZone, span.end - 1) }
}

const scheduleRows = (env: Env, workspaceId: string) =>
  all<ScheduleRow>(env.DB, 'SELECT * FROM report_schedules WHERE workspace_id = ? ORDER BY name COLLATE NOCASE, created_at', workspaceId)

export async function listSchedules(ctx: Ctx, workspaceId: string): Promise<ReportSchedule[]> {
  await enter(ctx, workspaceId, 'read', 'reports', 'admin')
  return (await scheduleRows(ctx.env, workspaceId)).map(toSchedule)
}

/** Links in each email use the origin it was created from. */
export async function createSchedule(ctx: Ctx, workspaceId: string, body: Json): Promise<ReportSchedule> {
  onlyKeys(body, ['name', 'by', 'cycle', 'recipients'])
  const { user } = await enter(ctx, workspaceId, 'write', 'reports', 'admin')
  const name = str(body, 'name', { max: 80 })
  const by = parseDimension(typeof body.by === 'string' ? body.by : null)
  const cycle = parseCycle(body.cycle, 'cycle', ['week', 'month'])
  const recipients = await memberIds(ctx.env, workspaceId, body.recipients, 'recipients')
  const { timeZone } = await usageSettings(ctx, workspaceId)
  const id = newId()
  const now = Date.now()
  await run(
    ctx.env.DB,
    `INSERT INTO report_schedules (id, workspace_id, name, dimension, cycle, recipients, origin, next_run_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    workspaceId,
    name,
    by,
    JSON.stringify(cycle),
    JSON.stringify(recipients),
    ctx.origin,
    nextRun(cycle, timeZone, now),
    user.id,
    now,
  )
  await changed(ctx, workspaceId, 'report.schedule_create', id, { name, by, cycle })
  const row = await first<ScheduleRow>(ctx.env.DB, 'SELECT * FROM report_schedules WHERE id = ?', id)
  return toSchedule(row as ScheduleRow)
}

export async function deleteSchedule(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  await enter(ctx, workspaceId, 'write', 'reports', 'admin')
  const row = await first<ScheduleRow>(ctx.env.DB, 'SELECT * FROM report_schedules WHERE id = ? AND workspace_id = ?', id, workspaceId)
  if (!row) throw notFound('Scheduled report not found')
  await run(ctx.env.DB, 'DELETE FROM report_schedules WHERE id = ?', id)
  await changed(ctx, workspaceId, 'report.schedule_delete', id, { name: row.name })
}
