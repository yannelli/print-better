import type { CommandName, UiEvent } from '../../shared/protocol'
import { DEFAULT_CLIENT_SETTINGS, type Client, type Os } from '../../shared/types'
import { clientSettings, JOB_VIEW, toClient, toJob, workspaceSettings } from '../db/map'
import type { ClientRow, JobViewRow, WorkspaceRow } from '../db/rows'
import { jobsEnded } from '../extensions/finish'
import type { Json } from '../http/body'
import { conflict, notFound } from '../http/errors'
import { NAME, oneOf, optObj, optStr } from '../http/validate'
import { newId, newToken, sha256Hex } from '../lib/crypto'
import { all, first, run } from '../lib/db'
import { requireMember, requireScope } from './access'
import { audit } from './audit'
import { mergeClientSettings } from './client-settings'
import type { Ctx } from './context'
import { hubFor, notifyHub } from './hub'
import { OPEN } from './jobs'

export interface DeviceInfo {
  name: string
  hostname: string | null
  os: Os | null
  arch: string | null
  version: string | null
}

export interface CommandResult {
  ok: boolean
  data?: unknown
  error?: string
}

/** What the hub returns over RPC: `data` travels as JSON text because `unknown` is not RPC-serializable in the types. */
export interface HubCommandResult {
  ok: boolean
  json?: string
  error?: string
}

/** Creates a paired device and returns its `pbc_` token (shown once). New devices inherit the workspace LAN-sharing default. */
export async function insertClient(ctx: Ctx, workspaceId: string, info: DeviceInfo): Promise<{ client: ClientRow; token: string }> {
  const ws = await first<WorkspaceRow>(ctx.env.DB, 'SELECT * FROM workspaces WHERE id = ?', workspaceId)
  if (!ws) throw notFound('Workspace not found')
  const token = newToken('pbc_')
  const now = Date.now()
  const settings = { ...DEFAULT_CLIENT_SETTINGS, lanSharing: workspaceSettings(ws.settings).lanSharing }
  const client = await first<ClientRow>(
    ctx.env.DB,
    `INSERT INTO clients (id, workspace_id, name, token_hash, hostname, os, arch, version, features, settings, settings_updated_at, online, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 0, ?) RETURNING *`,
    newId(),
    workspaceId,
    info.name,
    await sha256Hex(token),
    info.hostname,
    info.os,
    info.arch,
    info.version,
    JSON.stringify(settings),
    now,
    now,
  )
  if (!client) throw new Error('client insert returned no row')
  notifyHub(ctx, workspaceId, (hub) => hub.broadcast([{ type: 'client', client: toClient(client) }]))
  return { client, token }
}

export async function loadClient(env: Env, workspaceId: string, id: string): Promise<ClientRow> {
  const row = await first<ClientRow>(env.DB, 'SELECT * FROM clients WHERE id = ? AND workspace_id = ?', id, workspaceId)
  if (!row) throw notFound('Device not found')
  return row
}

export async function listClients(ctx: Ctx, workspaceId: string): Promise<Client[]> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId)
  return (await all<ClientRow>(ctx.env.DB, 'SELECT * FROM clients WHERE workspace_id = ? ORDER BY created_at', workspaceId)).map(toClient)
}

export async function getClient(ctx: Ctx, workspaceId: string, id: string): Promise<Client> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId)
  return toClient(await loadClient(ctx.env, workspaceId, id))
}

/** Settings edits bump `settingsUpdatedAt` past the stored value so they win last-write-wins on the device. */
export async function patchClient(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<Client> {
  requireScope(ctx, 'write')
  await requireMember(ctx, workspaceId, 'admin')
  const row = await loadClient(ctx.env, workspaceId, id)
  const name = optStr(body, 'name', NAME) ?? row.name
  const patch = optObj(body, 'settings')
  const settings = patch ? mergeClientSettings(clientSettings(row.settings), patch) : clientSettings(row.settings)
  const updatedAt = patch ? Math.max(Date.now(), row.settings_updated_at + 1) : row.settings_updated_at
  const updated = await first<ClientRow>(
    ctx.env.DB,
    'UPDATE clients SET name = ?, settings = ?, settings_updated_at = ? WHERE id = ? RETURNING *',
    name,
    JSON.stringify(settings),
    updatedAt,
    id,
  )
  if (!updated) throw notFound('Device not found')
  await audit(ctx, workspaceId, 'client.update', id, { name: name !== row.name ? name : undefined, settings: patch ? Object.keys(patch) : undefined })
  notifyHub(ctx, workspaceId, (hub) => hub.pushSettings(workspaceId, id))
  return toClient(updated)
}

/** Revokes the device: open jobs are canceled, the device is told to unpair, and its printers go with it. */
export async function deleteClient(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  requireScope(ctx, 'write')
  await requireMember(ctx, workspaceId, 'admin')
  const row = await loadClient(ctx.env, workspaceId, id)
  const now = Date.now()
  await run(
    ctx.env.DB,
    `UPDATE jobs SET status = 'canceled', status_message = 'Device removed', completed_at = ?, updated_at = ?
     WHERE printer_id IN (SELECT id FROM printers WHERE client_id = ?) AND status IN ${OPEN}`,
    now,
    now,
    id,
  )
  const { rows: jobs, events: usage } = await jobsEnded(
    ctx,
    workspaceId,
    await all<JobViewRow>(ctx.env.DB, `${JOB_VIEW} WHERE p.client_id = ? AND j.updated_at = ? AND j.status = 'canceled'`, id, now),
  )
  const printers = await all<{ id: string }>(ctx.env.DB, 'SELECT id FROM printers WHERE client_id = ?', id)
  await hubFor(ctx.env, workspaceId)
    .disconnect({ clientId: id, unpair: true }, 4401, 'Device removed')
    .catch((e: unknown) => console.error('hub disconnect failed', e))
  await run(ctx.env.DB, 'DELETE FROM clients WHERE id = ?', id)
  await audit(ctx, workspaceId, 'client.delete', id, { name: row.name })
  const events: UiEvent[] = [
    ...jobs.map((j) => ({ type: 'job' as const, job: { ...toJob(j), printerId: null, printerName: null } })),
    ...usage,
    ...printers.map((p) => ({ type: 'printer_removed' as const, id: p.id })),
    { type: 'client_removed', id },
  ]
  notifyHub(ctx, workspaceId, (hub) => hub.broadcast(events))
}

const COMMANDS = ['discover', 'refresh', 'identify', 'logs', 'diagnose', 'restart', 'update'] as const

/** Relays a command and waits for its result (20 s); 409 when the device is offline. */
export async function sendCommand(ctx: Ctx, workspaceId: string, id: string, name: CommandName, args: Record<string, unknown>): Promise<CommandResult> {
  const result = await hubFor(ctx.env, workspaceId).command(workspaceId, id, name, args)
  if (!result) throw conflict('The device is offline', 'client_offline')
  await audit(ctx, workspaceId, 'client.command', id, { name, ok: result.ok })
  return { ok: result.ok, data: result.json === undefined ? undefined : JSON.parse(result.json), error: result.error }
}

export async function runCommand(ctx: Ctx, workspaceId: string, id: string, body: Json): Promise<CommandResult> {
  requireScope(ctx, 'write')
  await requireMember(ctx, workspaceId, 'admin')
  await loadClient(ctx.env, workspaceId, id)
  return sendCommand(ctx, workspaceId, id, oneOf(body, 'name', COMMANDS), optObj(body, 'args') ?? {})
}
