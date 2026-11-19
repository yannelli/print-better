import type { CostCenter, CostCenterDefaults } from '../../../shared/enterprise'
import type { Json } from '../../http/body'
import { badRequest } from '../../http/errors'
import { isObj } from '../../http/validate'
import { all, stmt } from '../../lib/db'
import type { Ctx } from '../../services/context'
import { isActive } from '../state'
import { changed, enter } from './guard'
import { costCenters } from './store'
import { onlyKeys } from './values'

type Kind = keyof CostCenterDefaults

const SUBJECTS: Record<Kind, { type: 'user' | 'group' | 'client'; column: string; table: string; label: string }> = {
  members: { type: 'user', column: 'user_id', table: 'members', label: 'member' },
  groups: { type: 'group', column: 'group_id', table: 'groups', label: 'group' },
  devices: { type: 'client', column: 'client_id', table: 'clients', label: 'device' },
}
const KINDS = Object.keys(SUBJECTS) as Kind[]

interface DefaultRow {
  subject_type: 'user' | 'group' | 'client'
  subject_id: string
  cost_center_id: string
  /** Groups only, for ordering. */
  group_name: string | null
}

const defaultRows = (env: Env, workspaceId: string): Promise<DefaultRow[]> =>
  all<DefaultRow>(
    env.DB,
    `SELECT d.subject_type, COALESCE(d.user_id, d.group_id, d.client_id) AS subject_id, d.cost_center_id, g.name AS group_name
     FROM cost_center_defaults d LEFT JOIN groups g ON g.id = d.group_id WHERE d.workspace_id = ?`,
    workspaceId,
  )

async function defaultsView(env: Env, workspaceId: string): Promise<CostCenterDefaults> {
  const rows = await defaultRows(env, workspaceId)
  const of = (type: DefaultRow['subject_type']) => Object.fromEntries(rows.filter((r) => r.subject_type === type).map((r) => [r.subject_id, r.cost_center_id]))
  return { members: of('user'), groups: of('group'), devices: of('client') }
}

export async function getDefaults(ctx: Ctx, workspaceId: string): Promise<CostCenterDefaults> {
  await enter(ctx, workspaceId, 'read', 'costCenters', 'admin')
  return defaultsView(ctx.env, workspaceId)
}

/** Merged; null removes a default. Subjects must exist here and cost centers must be active. */
export async function putDefaults(ctx: Ctx, workspaceId: string, body: Json): Promise<CostCenterDefaults> {
  await enter(ctx, workspaceId, 'write', 'costCenters', 'admin')
  onlyKeys(body, KINDS, 'The defaults')
  const centers = await costCenters(ctx.env, workspaceId)
  const writes: D1PreparedStatement[] = []
  for (const kind of KINDS) {
    const entries = body[kind]
    if (entries === undefined) continue
    if (!isObj(entries)) throw badRequest(`${kind} must be an object of ids to cost center ids`)
    const { type, column, table, label } = SUBJECTS[kind]
    const idColumn = table === 'members' ? 'user_id' : 'id'
    const found = await all<{ id: string }>(
      ctx.env.DB,
      `SELECT ${idColumn} AS id FROM ${table} WHERE workspace_id = ? AND ${idColumn} IN (SELECT value FROM json_each(?))`,
      workspaceId,
      JSON.stringify(Object.keys(entries)),
    )
    for (const [subject, value] of Object.entries(entries)) {
      if (!found.some((f) => f.id === subject)) throw badRequest(`${kind} has an id that isn't a ${label} of this workspace: ${subject}`)
      writes.push(stmt(ctx.env.DB, `DELETE FROM cost_center_defaults WHERE workspace_id = ? AND subject_type = ? AND ${column} = ?`, workspaceId, type, subject))
      if (value === null) continue
      if (typeof value !== 'string' || !centers.some((c) => c.id === value && c.active)) {
        throw badRequest(`${kind}.${subject} must be the id of an active cost center, or null`, 'cost_center_invalid')
      }
      writes.push(
        stmt(
          ctx.env.DB,
          `INSERT INTO cost_center_defaults (workspace_id, subject_type, ${column}, cost_center_id, updated_at) VALUES (?, ?, ?, ?, ?)`,
          workspaceId,
          type,
          subject,
          value,
          Date.now(),
        ),
      )
    }
  }
  if (writes.length > 0) {
    await ctx.env.DB.batch(writes)
    await changed(ctx, workspaceId, 'cost_center.defaults', workspaceId, { changes: body })
  }
  return defaultsView(ctx.env, workspaceId)
}

export interface Charged {
  userId: string | null
  clientId: string | null
  /** Printer access groups of the sender; empty while it is off. */
  groups: readonly string[]
}

/** The member's default, else their groups' (first by name), else the device's. Inactive ones are skipped. */
export async function defaultFor(env: Env, workspaceId: string, who: Charged, centers: readonly CostCenter[]): Promise<string | null> {
  if (!who.userId && !who.clientId) return null
  const rows = (await defaultRows(env, workspaceId)).filter((r) => centers.some((c) => c.id === r.cost_center_id && c.active))
  const member = rows.find((r) => r.subject_type === 'user' && r.subject_id === who.userId)
  const groups = rows
    .filter((r) => r.subject_type === 'group' && who.groups.includes(r.subject_id))
    .sort((a, b) => (a.group_name ?? '').localeCompare(b.group_name ?? '', undefined, { sensitivity: 'base' }))
  const device = rows.find((r) => r.subject_type === 'client' && r.subject_id === who.clientId)
  return (member ?? groups[0] ?? device)?.cost_center_id ?? null
}

/** What a member's jobs are charged to when they pick none. */
export async function memberDefault(ctx: Ctx, workspaceId: string, userId: string, centers: readonly CostCenter[]): Promise<string | null> {
  const groups = (await isActive(ctx, workspaceId, 'printer-access'))
    ? (await all<{ group_id: string }>(ctx.env.DB, 'SELECT group_id FROM group_members WHERE workspace_id = ? AND user_id = ?', workspaceId, userId)).map((g) => g.group_id)
    : []
  return defaultFor(ctx.env, workspaceId, { userId, clientId: null, groups }, centers)
}
