import { bearerToken, lookupApiToken } from '../auth/tokens'
import { mcpResource, SCOPES, type Scope } from '../oauth/common'
import type { Ctx } from '../services/context'

const resourceMetadata = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`

function challenge(status: 401 | 403, header: string, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status, headers: { 'WWW-Authenticate': header, 'Cache-Control': 'no-store' } })
}

/** 401 with RFC 9728 discovery; a request without credentials gets no error code (RFC 6750 §3.1). */
function unauthorized(origin: string, invalid: boolean): Response {
  const params = [`resource_metadata="${resourceMetadata(origin)}"`, `scope="${SCOPES.join(' ')}"`]
  if (invalid) params.unshift('error="invalid_token"', 'error_description="The access token is invalid or expired"')
  return challenge(401, `Bearer ${params.join(', ')}`, 'invalid_token', invalid ? 'The access token is invalid or expired' : 'Sign in to use Print Better')
}

/** Asks for every scope at once, so a client steps up a single time. */
export function insufficientScope(origin: string, needed: Scope): Response {
  const header = `Bearer error="insufficient_scope", scope="${SCOPES.join(' ')}", resource_metadata="${resourceMetadata(origin)}"`
  return challenge(403, header, 'insufficient_scope', `This tool needs the "${needed}" permission`)
}

/** Bearer only (never cookies): personal `pbt_` tokens, or `pbo_` access tokens issued for this `/mcp`. */
export async function mcpContext(req: Request, env: Env, url: URL, waitUntil: Ctx['waitUntil']): Promise<Ctx | Response> {
  const token = bearerToken(req)
  if (!token) return unauthorized(url.origin, false)
  const accepted = token.startsWith('pbt_') || token.startsWith('pbo_')
  const found = accepted ? await lookupApiToken(env, token, waitUntil) : null
  if (!found || (token.startsWith('pbo_') && found.resource !== mcpResource(url.origin))) return unauthorized(url.origin, true)
  return {
    env,
    actor: { type: 'token', user: found.user, tokenId: found.tokenId, workspaceId: found.workspaceId, scopes: found.scopes },
    origin: url.origin,
    ip: req.headers.get('CF-Connecting-IP'),
    userAgent: req.headers.get('User-Agent'),
    via: 'mcp',
    waitUntil,
  }
}
