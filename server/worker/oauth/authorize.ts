import { putChallenge } from '../lib/challenges'
import { newId } from '../lib/crypto'
import { limit } from '../lib/throttle'
import { MINUTE } from '../lib/time'
import { findClient } from './clients'
import { grantedScopes, isMcpResource, mcpResource, oauthJson, redirectAllowed, REQUEST_TTL, withParams, type Scope } from './common'

/** An authorization request waiting on the consent page (challenge kind `oauth-request`). */
export interface OAuthRequest {
  clientId: string
  clientName: string
  clientUri: string | null
  logoUri: string | null
  redirectUri: string
  codeChallenge: string
  scopes: Scope[]
  resource: string
  state: string | null
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } })

/** `GET /oauth/authorize`. Bad client or redirect URI answers JSON; other errors redirect back with `iss` (RFC 9207). */
export async function authorize(env: Env, req: Request, url: URL): Promise<Response> {
  await limit(env, `oauth-authorize:${req.headers.get('CF-Connecting-IP') ?? 'unknown'}`, 60, 10 * MINUTE)
  const q = url.searchParams
  const clientId = q.get('client_id')
  const client = clientId ? await findClient(env, clientId) : null
  if (!client) return oauthJson({ error: 'invalid_client', error_description: 'Unknown client_id' }, 400)
  const redirectUri = q.get('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null)
  if (!redirectUri || !redirectAllowed(client.redirectUris, redirectUri)) {
    return oauthJson({ error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' }, 400)
  }

  const state = q.get('state')
  const fail = (error: string, description: string) =>
    redirect(withParams(redirectUri, { error, error_description: description, state, iss: url.origin }))
  if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported')
  const challenge = q.get('code_challenge') ?? ''
  if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256')
  }
  const resource = q.get('resource')
  if (resource !== null && !isMcpResource(resource, url.origin)) return fail('invalid_target', `resource must be ${mcpResource(url.origin)}`)

  const request: OAuthRequest = {
    clientId: client.id,
    clientName: client.name,
    clientUri: client.uri,
    logoUri: client.logoUri,
    redirectUri,
    codeChallenge: challenge,
    scopes: grantedScopes(q.get('scope')),
    resource: mcpResource(url.origin),
    state,
  }
  const id = newId()
  await putChallenge(env, id, 'oauth-request', null, request, REQUEST_TTL)
  return redirect(`/oauth/consent?request=${id}`)
}
