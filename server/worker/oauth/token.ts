import { KB, readText } from '../http/body'
import { takeChallenge } from '../lib/challenges'
import { sha256, sha256Hex } from '../lib/crypto'
import { b64url } from '../lib/encoding'
import type { OAuthRequest } from './authorize'
import { clientIdOf, invalidGrant, isMcpResource, mcpResource, OAuthError, oauthJson } from './common'
import { issueTokens, rotate, type TokenResponse } from './grants'

/** An approved request waiting to be redeemed (challenge kind `oauth-code`, keyed by the code's hash). */
export interface CodeGrant extends OAuthRequest {
  workspaceId: string | null
}

const required = (form: URLSearchParams, name: string): string => {
  const value = form.get(name)
  if (!value) throw new OAuthError(400, 'invalid_request', `${name} is required`)
  return value
}

async function redeemCode(form: URLSearchParams, req: Request, env: Env, origin: string): Promise<TokenResponse> {
  const code = required(form, 'code')
  const verifier = required(form, 'code_verifier')
  const found = await takeChallenge<CodeGrant>(env, 'oauth-code', await sha256Hex(code))
  if (!found?.userId) throw invalidGrant('The authorization code is invalid, expired, or already used')
  const g = found.data
  if (clientIdOf(req, form) !== g.clientId) throw invalidGrant('The code was issued to a different client')
  if ((form.get('redirect_uri') ?? g.redirectUri) !== g.redirectUri) throw invalidGrant('redirect_uri does not match the authorization request')
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(await sha256(verifier)) !== g.codeChallenge) {
    throw invalidGrant('PKCE verification failed')
  }
  const resource = form.get('resource')
  if (resource !== null && !isMcpResource(resource, origin)) throw new OAuthError(400, 'invalid_target', `resource must be ${mcpResource(origin)}`)
  return issueTokens(
    env,
    { userId: found.userId, workspaceId: g.workspaceId, clientId: g.clientId, clientName: g.clientName, scopes: g.scopes, resource: g.resource },
    null,
  )
}

/** `POST /oauth/token` (form body): authorization_code with PKCE, or refresh_token with rotation. */
export async function tokenEndpoint(env: Env, req: Request, url: URL): Promise<Response> {
  if (!/^application\/x-www-form-urlencoded/i.test(req.headers.get('Content-Type') ?? '')) {
    throw new OAuthError(400, 'invalid_request', 'Send the token request as application/x-www-form-urlencoded')
  }
  const form = new URLSearchParams(await readText(req, 16 * KB))
  const grantType = form.get('grant_type')
  if (grantType === 'authorization_code') return oauthJson(await redeemCode(form, req, env, url.origin))
  if (grantType === 'refresh_token') {
    const resource = form.get('resource')
    if (resource !== null && !isMcpResource(resource, url.origin)) throw new OAuthError(400, 'invalid_target', `resource must be ${mcpResource(url.origin)}`)
    return oauthJson(await rotate(env, required(form, 'refresh_token'), clientIdOf(req, form), form.get('scope')))
  }
  throw new OAuthError(400, 'unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token')
}
