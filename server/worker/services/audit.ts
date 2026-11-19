import type { AuditEntry } from '../../shared/types'
import { toAudit } from '../db/map'
import type { AuditRow } from '../db/rows'
import { all, run } from '../lib/db'
import { decodeCursor, pageLimit, toPage, type Page } from '../lib/pagination'
import { requireMember, requireScope } from './access'
import { actorRef, type Ctx } from './context'

export async function audit(
  ctx: Ctx,
  workspaceId: string | null,
  action: string,
  target: string | null,
  data?: Record<string, unknown>,
): Promise<void> {
  const actor = actorRef(ctx.actor)
  await run(
    ctx.env.DB,
    'INSERT INTO audit_log (workspace_id, actor_type, actor_id, action, target, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    workspaceId,
    actor.type,
    actor.id,
    action,
    target,
    data ? JSON.stringify(data) : null,
    Date.now(),
  )
}

export async function listAudit(ctx: Ctx, workspaceId: string, cursor?: string | null, limit?: string | null): Promise<Page<AuditEntry>> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId, 'admin')
  const n = pageLimit(limit)
  const c = decodeCursor(cursor)
  const rows = await all<AuditRow>(
    ctx.env.DB,
    `SELECT a.*, COALESCE(u.name, cl.name, CASE WHEN a.actor_type = 'email' THEN a.actor_id END) AS actor_name
     FROM audit_log a
     LEFT JOIN users u ON a.actor_type IN ('user', 'token') AND u.id = a.actor_id
     LEFT JOIN clients cl ON a.actor_type = 'client' AND cl.id = a.actor_id
     WHERE a.workspace_id = ? AND (? IS NULL OR a.created_at < ? OR (a.created_at = ? AND a.id < ?))
     ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    workspaceId,
    c?.createdAt ?? null,
    c?.createdAt ?? null,
    c?.createdAt ?? null,
    c ? Number(c.id) : null,
    n + 1,
  )
  return toPage(rows, n, (r) => ({ createdAt: r.created_at, id: String(r.id) }), toAudit)
}
