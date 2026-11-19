import type { Os } from '../../shared/types'
import type { DeviceCodeRow } from '../db/rows'
import type { Json } from '../http/body'
import { ApiError, conflict, notFound } from '../http/errors'
import { NAME, optOneOf, optStr, str } from '../http/validate'
import { newToken, randomString, sha256Hex } from '../lib/crypto'
import { first, run } from '../lib/db'
import { assertUnder, hit, limit } from '../lib/throttle'
import { HOUR, MINUTE, SECOND } from '../lib/time'
import { requireMember, requireScope, requireUser, roleAtLeast } from './access'
import { audit } from './audit'
import { insertClient, type DeviceInfo } from './clients'
import { systemCtx, type Ctx } from './context'
import { listWorkspaces } from './workspaces'

// RFC 8628 base-20 alphabet without vowels, so codes never spell words and are hard to misread.
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
const LIFETIME = 10 * MINUTE
const INTERVAL_S = 5

const pollError = (code: string, message: string) => new ApiError(400, code, message)
const display = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`
const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z]/g, '')

export function parseDeviceInfo(body: Json): DeviceInfo {
  const hostname = optStr(body, 'hostname', { max: 253 }) ?? null
  return {
    name: optStr(body, 'name', NAME) ?? hostname ?? 'Device',
    hostname,
    os: (optOneOf(body, 'os', ['macos', 'windows', 'linux'] as const) ?? null) as Os | null,
    arch: optStr(body, 'arch', { max: 32 }) ?? null,
    version: optStr(body, 'version', { max: 32 }) ?? null,
  }
}

export async function startDeviceCode(ctx: Ctx, body: Json) {
  await limit(ctx.env, `device-code-ip:${ctx.ip ?? 'unknown'}`, 30, HOUR)
  const info = parseDeviceInfo(body)
  const deviceCode = newToken('pbd_')
  const now = Date.now()
  for (let attempt = 0; ; attempt++) {
    const userCode = randomString(ALPHABET, 8)
    try {
      await run(
        ctx.env.DB,
        `INSERT INTO device_codes (id, user_code, hostname, os, arch, version, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        await sha256Hex(deviceCode),
        userCode,
        info.hostname,
        info.os,
        info.arch,
        info.version,
        now + LIFETIME,
        now,
      )
      return {
        deviceCode,
        userCode: display(userCode),
        verificationUri: `${ctx.origin}/device`,
        verificationUriComplete: `${ctx.origin}/device?code=${display(userCode)}`,
        interval: INTERVAL_S,
        expiresIn: LIFETIME / SECOND,
      }
    } catch (e) {
      if (attempt >= 3 || !String(e).includes('UNIQUE')) throw e
    }
  }
}

/** Client polling: 200 with credentials once approved, else an RFC 8628 error code. */
export async function pollDeviceCode(ctx: Ctx, body: Json): Promise<{ clientId: string; workspaceId: string; name: string; token: string }> {
  const id = await sha256Hex(str(body, 'deviceCode', { max: 200 }))
  const row = await first<DeviceCodeRow>(ctx.env.DB, 'SELECT * FROM device_codes WHERE id = ?', id)
  const now = Date.now()
  if (!row || row.expires_at <= now || row.status === 'consumed') throw pollError('expired_token', 'This pairing code expired. Start again.')
  if (row.status === 'denied') throw pollError('access_denied', 'Pairing was denied')
  if (row.status === 'pending') {
    const tooFast = row.last_poll_at !== null && now - row.last_poll_at < (INTERVAL_S - 1) * SECOND
    await run(ctx.env.DB, 'UPDATE device_codes SET last_poll_at = ? WHERE id = ?', now, id)
    if (tooFast) throw pollError('slow_down', 'Polling too fast; wait 5 more seconds between requests')
    throw pollError('authorization_pending', 'Waiting for someone to approve this device')
  }
  const claimed = await run(ctx.env.DB, "UPDATE device_codes SET status = 'consumed' WHERE id = ? AND status = 'approved'", id)
  if (claimed === 0 || !row.workspace_id) throw pollError('expired_token', 'This pairing code was already used')
  const { client, token } = await insertClient(ctx, row.workspace_id, {
    name: row.client_name ?? row.hostname ?? 'Device',
    hostname: row.hostname,
    os: row.os as Os | null,
    arch: row.arch,
    version: row.version,
  })
  await audit(systemCtx(ctx.env, ctx.origin, ctx.waitUntil, { type: 'client', client }), client.workspace_id, 'client.enroll', client.id, {
    via: 'device_code',
    approvedBy: row.approved_by,
  })
  return { clientId: client.id, workspaceId: client.workspace_id, name: client.name, token }
}

/** Failed lookups are counted per user so an 8-character code cannot be brute-forced (RFC 8628 §5.1). */
async function findPending(ctx: Ctx, userCode: string): Promise<DeviceCodeRow> {
  const user = requireUser(ctx)
  const key = `device-lookup:${user.id}`
  await assertUnder(ctx.env, key, 10)
  const code = normalize(userCode)
  const row =
    code.length === 8
      ? await first<DeviceCodeRow>(ctx.env.DB, "SELECT * FROM device_codes WHERE user_code = ? AND status = 'pending' AND expires_at > ?", code, Date.now())
      : null
  if (!row) {
    await hit(ctx.env, key, 15 * MINUTE)
    throw notFound('That code is not valid or has expired', 'device_code_invalid')
  }
  return row
}

/** Includes the workspaces where the caller may approve (admin or owner). */
export async function describeDeviceCode(ctx: Ctx, userCode: string) {
  requireScope(ctx, 'read')
  const row = await findPending(ctx, userCode)
  const workspaces = (await listWorkspaces(ctx)).filter((w) => roleAtLeast(w.role, 'admin'))
  return { hostname: row.hostname, os: row.os as Os | null, arch: row.arch, version: row.version, expiresAt: row.expires_at, workspaces }
}

export async function approveDeviceCode(ctx: Ctx, userCode: string, body: Json): Promise<void> {
  requireScope(ctx, 'write')
  const row = await findPending(ctx, userCode)
  const workspaceId = str(body, 'workspaceId', { max: 64 })
  const { user } = await requireMember(ctx, workspaceId, 'admin')
  const name = optStr(body, 'name', NAME) ?? row.hostname ?? 'Device'
  const changed = await run(
    ctx.env.DB,
    "UPDATE device_codes SET status = 'approved', workspace_id = ?, client_name = ?, approved_by = ? WHERE id = ? AND status = 'pending'",
    workspaceId,
    name,
    user.id,
    row.id,
  )
  if (changed === 0) throw conflict('This code was already handled', 'device_code_invalid')
  await audit(ctx, workspaceId, 'client.approve', null, { hostname: row.hostname, name })
}

export async function denyDeviceCode(ctx: Ctx, userCode: string): Promise<void> {
  requireScope(ctx, 'write')
  const row = await findPending(ctx, userCode)
  await run(ctx.env.DB, "UPDATE device_codes SET status = 'denied' WHERE id = ? AND status = 'pending'", row.id)
}
