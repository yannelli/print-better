import type { ApiToken } from '../../shared/types'
import { toApiToken } from '../db/map'
import type { ApiTokenRow } from '../db/rows'
import type { Json } from '../http/body'
import { notFound } from '../http/errors'
import { NAME, optInt, optStr, str } from '../http/validate'
import { newId, newToken, sha256Hex } from '../lib/crypto'
import { all, first, run } from '../lib/db'
import { DAY } from '../lib/time'
import { requireMember, requireScope, requireSessionUser, requireUser } from './access'
import { audit } from './audit'
import type { Ctx } from './context'

// OAuth grants are stored as a root token (parent_id NULL) with derived tokens pointing at it;
// listing shows roots only and revoking a root revokes its children.

export async function listTokens(ctx: Ctx): Promise<ApiToken[]> {
  requireScope(ctx, 'read')
  const user = requireUser(ctx)
  const rows = await all<ApiTokenRow>(
    ctx.env.DB,
    'SELECT * FROM api_tokens WHERE user_id = ? AND parent_id IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC',
    user.id,
    Date.now(),
  )
  return rows.map(toApiToken)
}

/** Personal API token (`pbt_`), optionally pinned to one workspace. Returned in full only here. */
export async function createToken(ctx: Ctx, body: Json): Promise<{ token: string; apiToken: ApiToken }> {
  const { user } = requireSessionUser(ctx)
  const name = str(body, 'name', NAME)
  const workspaceId = optStr(body, 'workspaceId', { max: 64 }) ?? null
  const days = optInt(body, 'expiresInDays', 1, 3650)
  if (workspaceId) await requireMember(ctx, workspaceId)
  const token = newToken('pbt_')
  const now = Date.now()
  const row: ApiTokenRow = {
    id: newId(),
    user_id: user.id,
    workspace_id: workspaceId,
    kind: 'pat',
    name,
    token_hash: await sha256Hex(token),
    scopes: '["read","write","print"]',
    oauth_client_id: null,
    parent_id: null,
    created_at: now,
    last_used_at: null,
    expires_at: days ? now + days * DAY : null,
    resource: null,
  }
  await run(
    ctx.env.DB,
    `INSERT INTO api_tokens (id, user_id, workspace_id, kind, name, token_hash, scopes, created_at, expires_at)
     VALUES (?, ?, ?, 'pat', ?, ?, ?, ?, ?)`,
    row.id,
    row.user_id,
    row.workspace_id,
    row.name,
    row.token_hash,
    row.scopes,
    row.created_at,
    row.expires_at,
  )
  await audit(ctx, workspaceId, 'token.create', row.id, { name })
  return { token, apiToken: toApiToken(row) }
}

export async function deleteToken(ctx: Ctx, id: string): Promise<void> {
  requireScope(ctx, 'write')
  const user = requireUser(ctx)
  const row = await first<ApiTokenRow>(ctx.env.DB, 'SELECT * FROM api_tokens WHERE id = ? AND user_id = ?', id, user.id)
  if (!row) throw notFound('Token not found')
  await run(ctx.env.DB, 'DELETE FROM api_tokens WHERE user_id = ? AND (id = ? OR parent_id = ?)', user.id, id, id)
  await audit(ctx, row.workspace_id, 'token.revoke', id, { name: row.name })
}
