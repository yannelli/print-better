import type { AuditEntry } from '../../shared/types'
import type { Ctx } from '../services/context'
import { AUDIT_VIEW_HOOKS, type AuditView } from './hooks'
import { isActive } from './state'

/** Every active extension's audit view composed; entries pass unchanged when none applies. */
export async function auditViewer(ctx: Ctx, workspaceId: string): Promise<(entry: AuditEntry) => AuditEntry> {
  const views: AuditView[] = []
  for (const hook of AUDIT_VIEW_HOOKS) {
    if (!(await isActive(ctx, workspaceId, hook.extension))) continue
    const view = await hook.load(ctx.env, workspaceId)
    if (view) views.push(view)
  }
  if (views.length === 0) return (entry) => entry
  return (entry) => (entry.data ? { ...entry, data: views.reduce((data, view) => view(data), entry.data) } : entry)
}
