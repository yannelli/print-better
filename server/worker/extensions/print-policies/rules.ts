import type { PrintRule } from '../../../shared/policies'
import type { Json } from '../../http/body'
import { badRequest, notFound } from '../../http/errors'
import { newId } from '../../lib/crypto'
import { first, run, stmt } from '../../lib/db'
import type { Ctx } from '../../services/context'
import { changed, enter } from './guard'
import { parseRule } from './rule-values'
import { loadRules, type RuleRow, toRule } from './store'

async function ruleView(env: Env, workspaceId: string, id: string): Promise<PrintRule> {
  const row = await first<RuleRow>(env.DB, 'SELECT * FROM print_rules WHERE id = ? AND workspace_id = ?', id, workspaceId)
  if (!row) throw notFound('Rule not found')
  return toRule(row)
}

/** `GET /policies/rules`: top to bottom. */
export async function listRules(ctx: Ctx, workspaceId: string): Promise<PrintRule[]> {
  await enter(ctx, workspaceId, 'read', true)
  return loadRules(ctx.env, workspaceId)
}

/** `POST /policies/rules`: added at the bottom. */
export async function createRule(ctx: Ctx, workspaceId: string, body: Json): Promise<PrintRule> {
  await enter(ctx, workspaceId, 'write', true)
  const rule = await parseRule(ctx.env, workspaceId, body)
  const id = newId()
  const now = Date.now()
  await run(
    ctx.env.DB,
    `INSERT INTO print_rules (id, workspace_id, name, enabled, exempt_admins, position, conditions, actions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM print_rules WHERE workspace_id = ?), ?, ?, ?, ?)`,
    id,
    workspaceId,
    rule.name,
    rule.enabled ? 1 : 0,
    rule.exemptAdmins ? 1 : 0,
    workspaceId,
    JSON.stringify(rule.conditions),
    JSON.stringify(rule.actions),
    now,
    now,
  )
  await changed(ctx, workspaceId, 'rule.create', id, { name: rule.name })
  return ruleView(ctx.env, workspaceId, id)
}

/** `PATCH /policies/rules/:id`: any of the input fields. */
export async function updateRule(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<PrintRule> {
  await enter(ctx, workspaceId, 'write', true)
  const rule = await parseRule(ctx.env, workspaceId, body, await ruleView(ctx.env, workspaceId, id))
  await run(
    ctx.env.DB,
    'UPDATE print_rules SET name = ?, enabled = ?, exempt_admins = ?, conditions = ?, actions = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    rule.name,
    rule.enabled ? 1 : 0,
    rule.exemptAdmins ? 1 : 0,
    JSON.stringify(rule.conditions),
    JSON.stringify(rule.actions),
    Date.now(),
    id,
    workspaceId,
  )
  await changed(ctx, workspaceId, 'rule.update', id, { fields: Object.keys(body) })
  return ruleView(ctx.env, workspaceId, id)
}

export async function deleteRule(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  await enter(ctx, workspaceId, 'write', true)
  const rule = await ruleView(ctx.env, workspaceId, id)
  await run(ctx.env.DB, 'DELETE FROM print_rules WHERE id = ? AND workspace_id = ?', id, workspaceId)
  await changed(ctx, workspaceId, 'rule.delete', id, { name: rule.name })
}

/** `PUT /policies/rules/order`: `ids` lists every rule, top to bottom. */
export async function reorderRules(ctx: Ctx, workspaceId: string, body: Json): Promise<PrintRule[]> {
  await enter(ctx, workspaceId, 'write', true)
  const ids = body.ids
  const current = await loadRules(ctx.env, workspaceId)
  const known = new Set(current.map((r) => r.id))
  const valid = Array.isArray(ids) && ids.length === known.size && new Set(ids).size === ids.length && ids.every((id) => typeof id === 'string' && known.has(id))
  if (!valid) throw badRequest('ids must list every rule exactly once, top to bottom')
  const now = Date.now()
  const moves = (ids as string[]).map((id, position) =>
    stmt(ctx.env.DB, 'UPDATE print_rules SET position = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', position, now, id, workspaceId),
  )
  if (moves.length > 0) await ctx.env.DB.batch(moves)
  await changed(ctx, workspaceId, 'rule.reorder', workspaceId, { ids })
  return loadRules(ctx.env, workspaceId)
}
