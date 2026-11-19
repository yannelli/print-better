import { EXTENSIONS, type ExtensionInfo, type InstanceExtension, type WorkspaceExtension } from '../../shared/extensions'
import type { Json } from '../http/body'
import { badRequest, conflict } from '../http/errors'
import { all } from '../lib/db'
import { requireInstanceAdmin, requireMember, requireScope } from '../services/access'
import { audit } from '../services/audit'
import type { Ctx } from '../services/context'
import { notifyHub } from '../services/hub'
import { availableExtensions, extensionInfo, saveAvailable, setEnabled, workspaceExtensions } from './state'

function switchValue(body: Json, key: 'available' | 'enabled'): boolean {
  const value = body[key]
  if (typeof value !== 'boolean') throw badRequest(`${key} must be true or false`)
  return value
}

async function enabledCounts(env: Env): Promise<Map<string, number>> {
  const rows = await all<{ extension_id: string; n: number }>(env.DB, 'SELECT extension_id, COUNT(*) AS n FROM workspace_extensions WHERE enabled = 1 GROUP BY extension_id')
  return new Map(rows.map((r) => [r.extension_id, r.n]))
}

const instanceView = (ext: ExtensionInfo, available: Set<string>, counts: Map<string, number>): InstanceExtension => ({
  ...ext,
  available: available.has(ext.id),
  enabledWorkspaces: counts.get(ext.id) ?? 0,
})

/** Pages refetch and devices get fresh snapshots after either switch moves. */
const accessChanged = (ctx: Ctx, workspaceId: string) => notifyHub(ctx, workspaceId, (hub) => hub.accessChanged())

export async function listInstanceExtensions(ctx: Ctx): Promise<InstanceExtension[]> {
  requireScope(ctx, 'read')
  requireInstanceAdmin(ctx)
  const [available, counts] = await Promise.all([availableExtensions(ctx.env), enabledCounts(ctx.env)])
  return EXTENSIONS.map((ext) => instanceView(ext, available, counts))
}

/** Making one unavailable turns it off everywhere at once; workspaces keep their switch and data. */
export async function patchInstanceExtension(ctx: Ctx, id: string, body: Json): Promise<InstanceExtension> {
  requireScope(ctx, 'write')
  requireInstanceAdmin(ctx)
  const ext = extensionInfo(id)
  const wanted = switchValue(body, 'available')
  const available = await availableExtensions(ctx.env)
  if (available.has(ext.id) !== wanted) {
    if (wanted) available.add(ext.id)
    else available.delete(ext.id)
    await saveAvailable(ctx.env, available)
    await audit(ctx, null, 'extension.update', ext.id, { available: wanted })
    // Best effort: every workspace hears about it, including ones whose settings page only shows availability.
    for (const w of await all<{ id: string }>(ctx.env.DB, 'SELECT id FROM workspaces')) accessChanged(ctx, w.id)
  }
  return instanceView(ext, available, await enabledCounts(ctx.env))
}

async function workspaceViews(env: Env, workspaceId: string): Promise<WorkspaceExtension[]> {
  const [available, rows] = await Promise.all([availableExtensions(env), workspaceExtensions(env, workspaceId)])
  return EXTENSIONS.map((ext) => {
    const enabled = rows.some((r) => r.extension_id === ext.id && r.enabled === 1)
    return { ...ext, available: available.has(ext.id), enabled, active: enabled && available.has(ext.id) }
  })
}

export async function listWorkspaceExtensions(ctx: Ctx, workspaceId: string): Promise<WorkspaceExtension[]> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId)
  return workspaceViews(ctx.env, workspaceId)
}

/** Turning one off always works; turning it on needs a server admin to have made it available. */
export async function patchWorkspaceExtension(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<WorkspaceExtension> {
  requireScope(ctx, 'write')
  await requireMember(ctx, workspaceId, 'owner')
  const ext = extensionInfo(id)
  const wanted = switchValue(body, 'enabled')
  const current = (await workspaceViews(ctx.env, workspaceId)).find((e) => e.id === ext.id) as WorkspaceExtension
  if (wanted && !current.available) throw conflict(`A server admin has to make ${ext.name} available first, under Admin > Extensions`, 'extension_unavailable')
  if (current.enabled !== wanted) {
    await setEnabled(ctx.env, workspaceId, ext.id, wanted)
    await audit(ctx, workspaceId, 'extension.update', ext.id, { enabled: wanted })
    accessChanged(ctx, workspaceId)
  }
  return { ...current, enabled: wanted, active: wanted && current.available }
}
