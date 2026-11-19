import type { ApiTokenRow } from '../db/rows'
import { KB, readText } from '../http/body'
import { newId, newToken, sha256Hex } from '../lib/crypto'
import { first, parseJson, run, stmt } from '../lib/db'
import { ACCESS_TTL, clientIdOf, invalidGrant, OAuthError, REFRESH_TTL, type Scope } from './common'

export interface Grant {
  userId: string
  workspaceId: string | null
  clientId: string
  clientName: string
  scopes: Scope[]
  resource: string
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

function tokenRow(g: Grant, kind: ApiTokenRow['kind'], hash: string, parentId: string | null, ttl: number, now: number): ApiTokenRow {
  return {
    id: newId(),
    user_id: g.userId,
    workspace_id: g.workspaceId,
    kind,
    name: g.clientName,
    token_hash: hash,
    scopes: JSON.stringify(g.scopes),
    oauth_client_id: g.clientId,
    parent_id: parentId,
    created_at: now,
    last_used_at: null,
    expires_at: now + ttl,
    resource: g.resource,
  }
}

const insert = (env: Env, r: ApiTokenRow) =>
  stmt(
    env.DB,
    `INSERT INTO api_tokens (id, user_id, workspace_id, kind, name, token_hash, scopes, oauth_client_id, parent_id, created_at, last_used_at, expires_at, resource)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.id,
    r.user_id,
    r.workspace_id,
    r.kind,
    r.name,
    r.token_hash,
    r.scopes,
    r.oauth_client_id,
    r.parent_id,
    r.created_at,
    r.last_used_at,
    r.expires_at,
    r.resource,
  )

// A family's first refresh token is its root (listed in Account → API tokens); later tokens point at it.
export async function issueTokens(env: Env, g: Grant, rootId: string | null): Promise<TokenResponse> {
  const now = Date.now()
  const access = newToken('pbo_')
  const refresh = newToken('pbr_')
  const refreshRow = tokenRow(g, 'oauth-refresh', await sha256Hex(refresh), rootId, REFRESH_TTL, now)
  const accessRow = tokenRow(g, 'oauth-access', await sha256Hex(access), rootId ?? refreshRow.id, ACCESS_TTL, now)
  const batch = [insert(env, refreshRow), insert(env, accessRow)]
  // The root must outlive every token that points at it, so it takes the newest refresh expiry.
  if (rootId) batch.push(stmt(env.DB, 'UPDATE api_tokens SET last_used_at = ?, expires_at = MAX(expires_at, ?) WHERE id = ?', now, refreshRow.expires_at, rootId))
  await env.DB.batch(batch)
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: g.scopes.join(' ') }
}

export const revokeFamily = (env: Env, rootId: string) => run(env.DB, 'DELETE FROM api_tokens WHERE id = ? OR parent_id = ?', rootId, rootId)

/** Refresh-token rotation: each refresh token works once; presenting a used one revokes the family (RFC 9700 §4.14.2). */
export async function rotate(env: Env, refreshToken: string, clientId: string | null, requestedScope: string | null): Promise<TokenResponse> {
  const row = await first<ApiTokenRow>(env.DB, "SELECT * FROM api_tokens WHERE token_hash = ? AND kind = 'oauth-refresh'", await sha256Hex(refreshToken))
  const now = Date.now()
  if (!row || (clientId !== null && row.oauth_client_id !== clientId) || (row.expires_at !== null && row.expires_at <= now)) {
    throw invalidGrant('The refresh token is invalid or expired')
  }
  const rootId = row.parent_id ?? row.id
  if (row.last_used_at !== null) {
    await revokeFamily(env, rootId)
    throw invalidGrant('This refresh token was already used, so the connection was revoked. Connect again.')
  }
  const scopes = parseJson<Scope[]>(row.scopes, [])
  if (requestedScope && requestedScope.split(' ').some((s) => s !== 'offline_access' && !scopes.includes(s as Scope))) {
    throw new OAuthError(400, 'invalid_scope', 'A refresh cannot add scopes')
  }
  // Losing this race means a concurrent refresh with the same token, not a replay, so the family stays.
  const claimed = await run(env.DB, 'UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND last_used_at IS NULL', now, row.id)
  if (claimed === 0) throw invalidGrant('This refresh token was just used')
  const grant: Grant = {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    clientId: row.oauth_client_id ?? '',
    clientName: row.name,
    scopes,
    resource: row.resource ?? '',
  }
  return issueTokens(env, grant, rootId)
}

/** `POST /oauth/revoke` (RFC 7009): always 200; a refresh token takes its whole family with it. */
export async function revokeEndpoint(env: Env, req: Request): Promise<Response> {
  const form = new URLSearchParams(await readText(req, 16 * KB))
  const token = form.get('token')
  if (!token) throw new OAuthError(400, 'invalid_request', 'token is required')
  const row = await first<ApiTokenRow>(env.DB, "SELECT * FROM api_tokens WHERE token_hash = ? AND kind IN ('oauth-access', 'oauth-refresh')", await sha256Hex(token))
  const clientId = clientIdOf(req, form)
  if (row && (clientId === null || row.oauth_client_id === clientId)) {
    if (row.kind === 'oauth-refresh') await revokeFamily(env, row.parent_id ?? row.id)
    else await run(env.DB, 'DELETE FROM api_tokens WHERE id = ?', row.id)
  }
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
