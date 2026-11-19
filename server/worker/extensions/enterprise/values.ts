import type { ReportDimension } from '../../../shared/enterprise'
import type { Cycle, CycleKind, OverAction } from '../../../shared/usage'
import type { Json } from '../../http/body'
import { badRequest } from '../../http/errors'
import { isObj } from '../../http/validate'
import { all } from '../../lib/db'
import { localMidnight, type LocalDate } from '../usage/cycles'

/** Refuses keys a body may not have, like job options do. */
export function onlyKeys(body: Json, allowed: readonly string[], what = 'The request'): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) throw badRequest(`${what} has unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}`)
}

export const OVER_ACTIONS: readonly OverAction[] = ['block', 'warn', 'approval']
export const DIMENSIONS: readonly ReportDimension[] = ['member', 'group', 'device', 'printer', 'cost-center', 'source']

const intIn = (value: unknown, key: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw badRequest(`${key} must be a whole number from ${min} to ${max}`)
  return value
}

/** A `Cycle` from a body; `kinds` narrows the ones allowed. */
export function parseCycle(value: unknown, key = 'cycle', kinds: readonly CycleKind[] = ['day', 'week', 'month', 'quarter', 'year']): Cycle {
  if (!isObj(value) || typeof value.kind !== 'string' || !kinds.includes(value.kind as CycleKind)) {
    throw badRequest(`${key}.kind must be one of: ${kinds.join(', ')}`)
  }
  const at = (field: string) => `${key}.${field}`
  switch (value.kind as CycleKind) {
    case 'day':
      onlyKeys(value, ['kind'], key)
      return { kind: 'day' }
    case 'week':
      onlyKeys(value, ['kind', 'firstDay'], key)
      return { kind: 'week', firstDay: value.firstDay === undefined ? 1 : intIn(value.firstDay, at('firstDay'), 0, 6) }
    case 'month':
      onlyKeys(value, ['kind', 'startDay'], key)
      return { kind: 'month', startDay: value.startDay === undefined ? 1 : intIn(value.startDay, at('startDay'), 1, 28) }
    case 'quarter':
    case 'year':
      onlyKeys(value, ['kind', 'startMonth'], key)
      return { kind: value.kind as 'quarter' | 'year', startMonth: value.startMonth === undefined ? 1 : intIn(value.startMonth, at('startMonth'), 1, 12) }
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseDate(value: string | null, key: string): LocalDate {
  const m = value ? DATE.exec(value) : null
  const date = m && { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
  const real = date && date.month >= 1 && date.month <= 12 && new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDate() === date.day
  if (!date || !real) throw badRequest(`${key} must be a date like 2026-11-01`)
  return date
}

export const formatDate = (d: LocalDate): string => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`

export const nextDate = (d: LocalDate): LocalDate => {
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + 1))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

const MAX_DAYS = 366

/** `from` to `to`, both included, as local midnights in `timeZone`: one span per day. */
export function daySpans(timeZone: string, from: LocalDate, to: LocalDate): { day: string; start: number; end: number }[] {
  const days: { day: string; start: number; end: number }[] = []
  let date = from
  let start = localMidnight(timeZone, from)
  while (formatDate(date) <= formatDate(to)) {
    if (days.length === MAX_DAYS) throw badRequest(`A report covers at most ${MAX_DAYS} days`)
    const next = nextDate(date)
    const end = localMidnight(timeZone, next)
    days.push({ day: formatDate(date), start, end })
    date = next
    start = end
  }
  if (days.length === 0) throw badRequest('to must be on or after from')
  return days
}

/** Member ids of this workspace, each once; 400 for anyone else. */
export async function memberIds(env: Env, workspaceId: string, value: unknown, key: string): Promise<string[]> {
  if (!Array.isArray(value) || value.length > 100 || value.some((v) => typeof v !== 'string')) throw badRequest(`${key} must be a list of at most 100 member ids`)
  const ids = [...new Set(value as string[])]
  const found = await all<{ user_id: string }>(
    env.DB,
    'SELECT user_id FROM members WHERE workspace_id = ? AND user_id IN (SELECT value FROM json_each(?))',
    workspaceId,
    JSON.stringify(ids),
  )
  const missing = ids.filter((id) => !found.some((f) => f.user_id === id))
  if (missing.length > 0) throw badRequest(`${key} has ids that aren't members of this workspace: ${missing.join(', ')}`)
  return ids
}

const CYCLE_WORDS: Record<CycleKind, string> = { day: 'daily', week: 'weekly', month: 'monthly', quarter: 'quarterly', year: 'yearly' }
export const cycleWord = (cycle: Cycle): string => CYCLE_WORDS[cycle.kind]
