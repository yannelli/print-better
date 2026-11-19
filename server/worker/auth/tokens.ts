import type { ClientRow, UserRow } from '../db/rows'
import { sha256Hex } from '../lib/crypto'
import { first, parseJson, run } from '../lib/db'
import { MINUTE } from '../lib/time'

// last_used_at is advisory, so it is written at most every few minutes and off the request path.
const TOUCH_EVERY = 5 * MINUTE

export interface TokenLookup {
  tokenId: string
  workspaceId: string | null
  scopes: string[]
  /** Audience of an OAuth access token; null for personal tokens. */
  resource: string | null
  user: UserRow
}

/** Resolves a `pbt_` personal token or a `pbo_` OAuth access token. */
export async function lookupApiToken(env: Env, token: string, waitUntil: (p: Promise<unknown>) => void): Promise<TokenLookup | null> {
  const kind = token.startsWith('pbt_') ? 'pat' : token.startsWith('pbo_') ? 'oauth-access' : null
  if (!kind) return null
  const row = await first<UserRow & { t_id: string; t_workspace_id: string | null; t_scopes: string; t_expires_at: number | null; t_last_used_at: number | null; t_resource: string | null }>(
    env.DB,
    `SELECT u.*, t.id AS t_id, t.workspace_id AS t_workspace_id, t.scopes AS t_scopes,
            t.expires_at AS t_expires_at, t.last_used_at AS t_last_used_at, t.resource AS t_resource
     FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.kind = ?`,
    await sha256Hex(token),
    kind,
  )
  const now = Date.now()
  if (!row || (row.t_expires_at !== null && row.t_expires_at <= now)) return null
  if (row.t_last_used_at === null || now - row.t_last_used_at > TOUCH_EVERY) {
    waitUntil(run(env.DB, 'UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now, row.t_id))
  }
  return { tokenId: row.t_id, workspaceId: row.t_workspace_id, scopes: parseJson<string[]>(row.t_scopes, []), resource: row.t_resource, user: row }
}

/** Resolves a `pbc_` device token. */
export async function lookupClient(env: Env, token: string): Promise<ClientRow | null> {
  if (!token.startsWith('pbc_')) return null
  return first<ClientRow>(env.DB, 'SELECT * FROM clients WHERE token_hash = ?', await sha256Hex(token))
}

export function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('Authorization') ?? '')
  return m ? m[1] : null
}
