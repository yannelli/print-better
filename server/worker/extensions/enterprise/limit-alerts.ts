import type { Role } from '../../../shared/types'
import type { JobViewRow } from '../../db/rows'
import { all } from '../../lib/db'
import type { Ctx } from '../../services/context'
import { countOf, measure, type Count as LimitCount } from '../print-policies/meters'
import { loadLimits } from '../print-policies/store'
import { isActive } from '../state'
import { groupsOf } from '../usage/check'
import { cycleAt } from '../usage/cycles'
import { usageSettings } from '../usage/settings'
import { type Count, limitCount } from './alerts'

interface EntryRow {
  at: number
  user_id: string | null
  client_id: string | null
  printer_id: string | null
  role: Role | null
}

/** The limit counts that settled jobs landed in, with what the printers reported; Print rules and limits decides which. */
export async function settledLimitCounts(ctx: Ctx, workspaceId: string, rows: readonly JobViewRow[]): Promise<Count[]> {
  if (rows.length === 0 || !(await isActive(ctx, workspaceId, 'print-policies'))) return []
  const limits = (await loadLimits(ctx.env, workspaceId)).filter((l) => l.enabled)
  if (limits.length === 0) return []
  const entries = await all<EntryRow>(
    ctx.env.DB,
    `SELECT e.at, e.user_id, e.client_id, e.printer_id, m.role FROM usage_entries e
     LEFT JOIN members m ON m.workspace_id = e.workspace_id AND m.user_id = e.user_id
     WHERE e.workspace_id = ? AND e.estimated = 0 AND e.job_id IN (SELECT value FROM json_each(?))`,
    workspaceId,
    JSON.stringify(rows.map((r) => r.id)),
  )
  const { timeZone } = await usageSettings(ctx, workspaceId)
  const found = new Map<string, { count: LimitCount } & Pick<Count, 'subject' | 'person'>>()
  for (const e of entries) {
    const sender = { userId: e.user_id, clientId: e.client_id, groups: await groupsOf(ctx, workspaceId, { userId: e.user_id, clientId: e.client_id }) }
    const admin = e.role === 'owner' || e.role === 'admin'
    for (const limit of limits) {
      const counted = limit.exemptAdmins && admin ? null : countOf(limit, sender, (id) => id === e.printer_id)
      if (!counted) continue
      const span = cycleAt(limit.cycle, timeZone, e.at)
      const key = `${limit.id}|${span.start}|${counted.whose?.type ?? ''}|${counted.whose?.id ?? ''}`
      if (!found.has(key)) found.set(key, { count: { limit, span, whose: counted.whose }, ...limitCount(limit.scope, sender) })
    }
  }
  const list = [...found.values()]
  const meters = await measure(ctx.env, workspaceId, list.map((f) => f.count))
  return list.map(({ count: { limit }, subject, person }, i) => ({
    meter: { kind: 'limit', id: limit.id, name: limit.name, unit: limit.unit, amount: meters[i].amount, start: meters[i].start, end: meters[i].end },
    used: meters[i].used,
    subject,
    person,
  }))
}
