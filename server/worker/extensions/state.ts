import { EXTENSIONS, isExtensionId, type ExtensionId, type ExtensionInfo } from '../../shared/extensions'
import { notFound } from '../http/errors'
import { all, first, parseJson, run } from '../lib/db'
import { memo, type Ctx } from '../services/context'

/** Instance availability: `{ "available": ["printer-access"] }` in the settings table. */
const SETTINGS_KEY = 'extensions'

export interface WorkspaceExtensionRow {
  extension_id: string
  enabled: number
  config: string
}

export function extensionInfo(id: string): ExtensionInfo {
  const ext = EXTENSIONS.find((e) => e.id === id)
  if (!ext) throw notFound('Extension not found')
  return ext
}

function parseAvailable(value: string | null | undefined): Set<ExtensionId> {
  const ids = parseJson<{ available?: unknown }>(value, {}).available
  return new Set(Array.isArray(ids) ? ids.filter(isExtensionId) : [])
}

export async function availableExtensions(env: Env): Promise<Set<ExtensionId>> {
  const row = await first<{ value: string }>(env.DB, 'SELECT value FROM settings WHERE key = ?', SETTINGS_KEY)
  return parseAvailable(row?.value)
}

export async function saveAvailable(env: Env, ids: Set<ExtensionId>): Promise<void> {
  await run(
    env.DB,
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    SETTINGS_KEY,
    JSON.stringify({ available: [...ids] }),
    Date.now(),
  )
}

/** Active means both switches are on: available on the instance and enabled in the workspace. */
export async function extensionActive(env: Env, workspaceId: string, id: ExtensionId): Promise<boolean> {
  const row = await first<{ available: string | null; enabled: number | null }>(
    env.DB,
    `SELECT (SELECT value FROM settings WHERE key = ?) AS available,
            (SELECT enabled FROM workspace_extensions WHERE workspace_id = ? AND extension_id = ?) AS enabled`,
    SETTINGS_KEY,
    workspaceId,
    id,
  )
  return row?.enabled === 1 && parseAvailable(row.available).has(id)
}

/** Asked on every printer and job call, so it is looked up once per request. */
export const isActive = (ctx: Ctx, workspaceId: string, id: ExtensionId): Promise<boolean> =>
  memo(ctx, `extension:${workspaceId}:${id}`, () => extensionActive(ctx.env, workspaceId, id))

/** Entry check for every extension route and MCP tool. */
export async function requireActive(ctx: Ctx, workspaceId: string, id: ExtensionId): Promise<void> {
  if (await isActive(ctx, workspaceId, id)) return
  const { name } = extensionInfo(id)
  throw notFound(
    `${name} is turned off for this workspace. A server admin makes it available under Server admin > Extensions, then a workspace owner turns it on under Workspace settings > Extensions.`,
    'extension_inactive',
  )
}

export const workspaceExtensions = (env: Env, workspaceId: string): Promise<WorkspaceExtensionRow[]> =>
  all<WorkspaceExtensionRow>(env.DB, 'SELECT extension_id, enabled, config FROM workspace_extensions WHERE workspace_id = ?', workspaceId)

/** Sets the workspace switch, keeping the extension's settings. */
export async function setEnabled(env: Env, workspaceId: string, id: ExtensionId, enabled: boolean): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO workspace_extensions (workspace_id, extension_id, enabled, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, extension_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    workspaceId,
    id,
    enabled,
    Date.now(),
  )
}

export async function extensionConfig(env: Env, workspaceId: string, id: ExtensionId): Promise<Record<string, unknown>> {
  const row = await first<{ config: string }>(env.DB, 'SELECT config FROM workspace_extensions WHERE workspace_id = ? AND extension_id = ?', workspaceId, id)
  return parseJson<Record<string, unknown>>(row?.config, {})
}

export async function saveExtensionConfig(env: Env, workspaceId: string, id: ExtensionId, config: Record<string, unknown>): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO workspace_extensions (workspace_id, extension_id, enabled, config, updated_at) VALUES (?, ?, 0, ?, ?)
     ON CONFLICT (workspace_id, extension_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    workspaceId,
    id,
    JSON.stringify(config),
    Date.now(),
  )
}
