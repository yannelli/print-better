import type { Workspace, WorkspaceSettings, WorkspaceSummary } from '../../shared/types'
import { toWorkspace, workspaceSettings } from '../db/map'
import type { WorkspaceRow } from '../db/rows'
import type { Json } from '../http/body'
import { badRequest, forbidden, notFound } from '../http/errors'
import { NAME, nullableStr, optBool, optInt, optObj, optOneOf, optStr, str, strArray } from '../http/validate'
import { newId } from '../lib/crypto'
import { all, chunk, first, stmt } from '../lib/db'
import { requireMember, requireScope, requireUser } from './access'
import { audit } from './audit'
import type { Ctx } from './context'
import { hubFor, notifyHub } from './hub'

export async function userWorkspaces(env: Env, userId: string, pinned: string | null = null): Promise<WorkspaceSummary[]> {
  const rows = await all<WorkspaceSummary>(
    env.DB,
    `SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? AND (? IS NULL OR w.id = ?) ORDER BY w.created_at`,
    userId,
    pinned,
    pinned,
  )
  return rows
}

export async function listWorkspaces(ctx: Ctx): Promise<WorkspaceSummary[]> {
  requireScope(ctx, 'read')
  const user = requireUser(ctx)
  return userWorkspaces(ctx.env, user.id, ctx.actor.type === 'token' ? ctx.actor.workspaceId : null)
}

export async function insertWorkspace(env: Env, name: string, ownerId: string): Promise<WorkspaceRow> {
  const row: WorkspaceRow = { id: newId(), name, settings: '{}', created_at: Date.now() }
  await env.DB.batch([
    stmt(env.DB, 'INSERT INTO workspaces (id, name, settings, created_at) VALUES (?, ?, ?, ?)', row.id, row.name, row.settings, row.created_at),
    stmt(env.DB, "INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", row.id, ownerId, row.created_at),
  ])
  return row
}

export async function createWorkspace(ctx: Ctx, body: Json): Promise<Workspace> {
  requireScope(ctx, 'write')
  const user = requireUser(ctx)
  if (ctx.actor.type === 'token' && ctx.actor.workspaceId) throw forbidden('This token is limited to one workspace')
  const row = await insertWorkspace(ctx.env, str(body, 'name', NAME), user.id)
  await audit(ctx, row.id, 'workspace.create', row.id, { name: row.name })
  return toWorkspace(row, 'owner')
}

export async function loadWorkspace(env: Env, workspaceId: string): Promise<WorkspaceRow> {
  const row = await first<WorkspaceRow>(env.DB, 'SELECT * FROM workspaces WHERE id = ?', workspaceId)
  if (!row) throw notFound('Workspace not found')
  return row
}

export async function getWorkspace(ctx: Ctx, workspaceId: string): Promise<Workspace> {
  requireScope(ctx, 'read')
  const { role } = await requireMember(ctx, workspaceId)
  return toWorkspace(await loadWorkspace(ctx.env, workspaceId), role)
}

const ALLOW_ENTRY = { max: 254, pattern: /^(?:[^\s@]+@[^\s@]+\.[^\s@]+|@[^\s@]+\.[^\s@]+)$/, hint: 'allowlist entries must be addresses or "@domain"' }

/** Deep-merges a partial patch over the current settings, validating every field it touches. */
export function mergeWorkspaceSettings(current: WorkspaceSettings, patch: Json): WorkspaceSettings {
  const next = structuredClone(current)
  next.autoAdd = optOneOf(patch, 'autoAdd', ['smart', 'all', 'none'] as const) ?? next.autoAdd
  next.keepDocumentsHours = optInt(patch, 'keepDocumentsHours', 1, 24 * 90) ?? next.keepDocumentsHours
  next.jobTimeoutHours = optInt(patch, 'jobTimeoutHours', 1, 24 * 14) ?? next.jobTimeoutHours
  next.maxUploadMb = optInt(patch, 'maxUploadMb', 1, 100) ?? next.maxUploadMb
  next.lanSharing = optBool(patch, 'lanSharing') ?? next.lanSharing
  const email = optObj(patch, 'emailToPrint')
  if (email) {
    next.emailToPrint.enabled = optBool(email, 'enabled') ?? next.emailToPrint.enabled
    next.emailToPrint.allowMembers = optBool(email, 'allowMembers') ?? next.emailToPrint.allowMembers
    if (email.allowlist !== undefined) next.emailToPrint.allowlist = strArray(email, 'allowlist', 100, ALLOW_ENTRY).map((e) => e.toLowerCase())
  }
  const defaultPrinterId = nullableStr(patch, 'defaultPrinterId', { max: 64 })
  if (defaultPrinterId !== undefined) next.defaultPrinterId = defaultPrinterId
  return next
}

export async function patchWorkspace(ctx: Ctx, workspaceId: string, body: Json): Promise<Workspace> {
  requireScope(ctx, 'write')
  const { role } = await requireMember(ctx, workspaceId, 'admin')
  const row = await loadWorkspace(ctx.env, workspaceId)
  const name = optStr(body, 'name', NAME) ?? row.name
  const patch = optObj(body, 'settings')
  const settings = patch ? mergeWorkspaceSettings(workspaceSettings(row.settings), patch) : workspaceSettings(row.settings)
  if (patch?.defaultPrinterId && !(await first(ctx.env.DB, 'SELECT 1 AS one FROM printers WHERE id = ? AND workspace_id = ? AND added = 1', settings.defaultPrinterId, workspaceId))) {
    throw badRequest('defaultPrinterId must be an added printer in this workspace')
  }
  const updated: WorkspaceRow = { ...row, name, settings: JSON.stringify(settings) }
  await ctx.env.DB.prepare('UPDATE workspaces SET name = ?, settings = ? WHERE id = ?').bind(name, updated.settings, workspaceId).run()
  await audit(ctx, workspaceId, 'workspace.update', workspaceId, { fields: Object.keys(body), settings: patch ? Object.keys(patch) : undefined })
  notifyHub(ctx, workspaceId, (hub) => hub.broadcastWorkspace(workspaceId))
  return toWorkspace(updated, role)
}

/** Updates stored settings outside a user patch (e.g. clearing a deleted default printer). */
export async function saveWorkspaceSettings(env: Env, workspaceId: string, settings: WorkspaceSettings): Promise<void> {
  await env.DB.prepare('UPDATE workspaces SET settings = ? WHERE id = ?').bind(JSON.stringify(settings), workspaceId).run()
}

export async function deleteWorkspace(ctx: Ctx, workspaceId: string): Promise<void> {
  requireScope(ctx, 'write')
  await requireMember(ctx, workspaceId, 'owner')
  const files = await all<{ file_key: string }>(ctx.env.DB, 'SELECT file_key FROM jobs WHERE workspace_id = ? AND file_key IS NOT NULL', workspaceId)
  for (const keys of chunk(files.map((f) => f.file_key), 1000)) await ctx.env.FILES.delete(keys)
  await hubFor(ctx.env, workspaceId)
    .disconnect({ all: true }, 4401, 'Workspace deleted')
    .catch((e: unknown) => console.error('hub disconnect failed', e))
  await ctx.env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspaceId).run()
  await audit(ctx, null, 'workspace.delete', workspaceId)
}
