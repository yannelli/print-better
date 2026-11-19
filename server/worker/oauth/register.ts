import { KB, readJson } from '../http/body'
import { newId } from '../lib/crypto'
import { run } from '../lib/db'
import { limit } from '../lib/throttle'
import { HOUR } from '../lib/time'
import { httpsOrNull, type ClientMeta } from './clients'
import { OAuthError, oauthJson, validRedirectUri } from './common'

const GRANTS = ['authorization_code', 'refresh_token']

const invalid = (field: string, why: string) =>
  new OAuthError(400, field === 'redirect_uris' ? 'invalid_redirect_uri' : 'invalid_client_metadata', `${field}: ${why}`)

function subsetOf(value: unknown, allowed: string[], field: string): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !allowed.includes(v))) {
    throw invalid(field, `only ${allowed.join(', ')} are supported`)
  }
}

/** RFC 7591 dynamic registration for public clients (PKCE, no secret); cron drops registrations unused for 30 days. */
export async function registerClient(env: Env, req: Request): Promise<Response> {
  await limit(env, `oauth-register:${req.headers.get('CF-Connecting-IP') ?? 'unknown'}`, 20, HOUR)
  const body = await readJson(req, 16 * KB)
  const redirects = body.redirect_uris
  if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10) throw invalid('redirect_uris', 'between 1 and 10 URIs are required')
  if (redirects.some((u) => typeof u !== 'string' || !validRedirectUri(u))) {
    throw invalid('redirect_uris', 'each must be https, http on localhost/127.0.0.1, or an app scheme, without a fragment')
  }
  const authMethod = body.token_endpoint_auth_method ?? 'none'
  if (authMethod !== 'none') throw invalid('token_endpoint_auth_method', 'only public clients ("none") are supported; PKCE protects the code')
  subsetOf(body.grant_types, GRANTS, 'grant_types')
  subsetOf(body.response_types, ['code'], 'response_types')
  const applicationType = body.application_type === 'native' ? 'native' : 'web'
  const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : 'MCP client'

  const id = newId()
  const now = Date.now()
  const meta: ClientMeta = { type: 'dcr', clientUri: httpsOrNull(body.client_uri), logoUri: httpsOrNull(body.logo_uri), applicationType }
  await run(
    env.DB,
    'INSERT INTO oauth_clients (id, name, redirect_uris, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    name,
    JSON.stringify(redirects),
    JSON.stringify(meta),
    now,
  )
  return oauthJson(
    {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: redirects,
      grant_types: GRANTS,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: applicationType,
      ...(meta.clientUri ? { client_uri: meta.clientUri } : {}),
      ...(meta.logoUri ? { logo_uri: meta.logoUri } : {}),
    },
    201,
  )
}
