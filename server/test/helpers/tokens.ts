import { env } from 'cloudflare:workers'
import { newId, newToken, sha256Hex } from '../../worker/lib/crypto'

export interface TokenShape {
  kind?: 'pat' | 'oauth-access'
  /** null stores the column default (`["*"]`), as tokens minted before scopes existed have. */
  scopes?: string[] | null
  resource?: string | null
  workspaceId?: string | null
}

/** Stores a token row the API would not mint directly: narrow or legacy scopes, or an OAuth access token for a resource. */
export async function insertToken(userId: string, shape: TokenShape = {}): Promise<string> {
  const kind = shape.kind ?? 'pat'
  const token = newToken(kind === 'pat' ? 'pbt_' : 'pbo_')
  const scopes = shape.scopes === undefined ? ['read', 'write', 'print'] : shape.scopes
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, user_id, workspace_id, kind, name, token_hash, scopes, created_at, resource)
     VALUES (?, ?, ?, ?, 'raw', ?, COALESCE(?, '["*"]'), ?, ?)`,
  )
    .bind(newId(), userId, shape.workspaceId ?? null, kind, await sha256Hex(token), scopes === null ? null : JSON.stringify(scopes), Date.now(), shape.resource ?? null)
    .run()
  return token
}
