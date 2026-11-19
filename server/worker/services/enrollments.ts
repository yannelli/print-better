import type { Enrollment, EnrollmentToken } from '../../shared/types'
import { toEnrollment } from '../db/map'
import type { EnrollmentRow } from '../db/rows'
import type { Json } from '../http/body'
import { notFound, unauthorized } from '../http/errors'
import { nullableStr, optInt, str } from '../http/validate'
import { newId, newToken, sha256Hex } from '../lib/crypto'
import { all, first, run } from '../lib/db'
import { limit } from '../lib/throttle'
import { HOUR } from '../lib/time'
import { requireMember, requireScope } from './access'
import { audit } from './audit'
import { insertClient } from './clients'
import { systemCtx, type Ctx } from './context'
import { parseDeviceInfo } from './device-codes'

/** The exact copy-paste one-liners from docs/cli.md; the token is an argument, never baked into a cached script. */
export function installCommands(origin: string, token: string): Enrollment['commands'] {
  return {
    unix: `curl -fsSL ${origin}/install.sh | sh -s -- --token ${token}`,
    windows: `$env:PB_TOKEN='${token}'; irm ${origin}/install.ps1 | iex`,
  }
}

export async function createEnrollment(ctx: Ctx, workspaceId: string, body: Json): Promise<Enrollment> {
  requireScope(ctx, 'write')
  const { user } = await requireMember(ctx, workspaceId, 'admin')
  const label = nullableStr(body, 'label', { max: 100 }) ?? null
  const maxUses = optInt(body, 'maxUses', 1, 1000) ?? 1
  const ttlHours = optInt(body, 'ttlHours', 1, 24 * 30) ?? 24
  const token = newToken('pbe_')
  const now = Date.now()
  const id = newId()
  await run(
    ctx.env.DB,
    `INSERT INTO enrollment_tokens (id, workspace_id, token_hash, label, created_by, max_uses, uses, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    id,
    workspaceId,
    await sha256Hex(token),
    label,
    user.id,
    maxUses,
    now + ttlHours * HOUR,
    now,
  )
  await audit(ctx, workspaceId, 'enrollment.create', id, { label, maxUses, ttlHours })
  return { token, expiresAt: now + ttlHours * HOUR, server: ctx.origin, commands: installCommands(ctx.origin, token) }
}

export async function listEnrollments(ctx: Ctx, workspaceId: string): Promise<EnrollmentToken[]> {
  requireScope(ctx, 'read')
  await requireMember(ctx, workspaceId, 'admin')
  const rows = await all<EnrollmentRow>(
    ctx.env.DB,
    'SELECT * FROM enrollment_tokens WHERE workspace_id = ? AND expires_at > ? ORDER BY created_at DESC',
    workspaceId,
    Date.now(),
  )
  return rows.map(toEnrollment)
}

export async function deleteEnrollment(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  requireScope(ctx, 'write')
  await requireMember(ctx, workspaceId, 'admin')
  const changed = await run(ctx.env.DB, 'DELETE FROM enrollment_tokens WHERE id = ? AND workspace_id = ?', id, workspaceId)
  if (changed === 0) throw notFound('Enrollment token not found')
  await audit(ctx, workspaceId, 'enrollment.delete', id)
}

/** `POST /api/client/enroll`: consumes one use atomically, then mints the device token. */
export async function enroll(ctx: Ctx, body: Json): Promise<{ clientId: string; workspaceId: string; name: string; token: string }> {
  await limit(ctx.env, `enroll-ip:${ctx.ip ?? 'unknown'}`, 30, HOUR)
  const token = str(body, 'token', { max: 200 })
  const info = parseDeviceInfo(body)
  const consumed = token.startsWith('pbe_')
    ? await first<{ id: string; workspace_id: string }>(
        ctx.env.DB,
        'UPDATE enrollment_tokens SET uses = uses + 1 WHERE token_hash = ? AND uses < max_uses AND expires_at > ? RETURNING id, workspace_id',
        await sha256Hex(token),
        Date.now(),
      )
    : null
  if (!consumed) throw unauthorized('This pairing token is invalid, used up, or expired', 'invalid_token')
  const { client, token: deviceToken } = await insertClient(ctx, consumed.workspace_id, info)
  await audit(systemCtx(ctx.env, ctx.origin, ctx.waitUntil, { type: 'client', client }), client.workspace_id, 'client.enroll', client.id, {
    enrollmentId: consumed.id,
    hostname: client.hostname,
  })
  return { clientId: client.id, workspaceId: client.workspace_id, name: client.name, token: deviceToken }
}
