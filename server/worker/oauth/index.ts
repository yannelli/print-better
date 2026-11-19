import { ApiError } from '../http/errors'
import { authorize } from './authorize'
import { OAuthError, oauthJson } from './common'
import { revokeEndpoint } from './grants'
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata'
import { registerClient } from './register'
import { tokenEndpoint } from './token'

type Endpoint = (env: Env, req: Request, url: URL) => Promise<Response> | Response

const ENDPOINTS: Record<string, { method: 'GET' | 'POST'; run: Endpoint }> = {
  '/.well-known/oauth-protected-resource': { method: 'GET', run: (_env, _req, url) => protectedResourceMetadata(url.origin) },
  '/.well-known/oauth-protected-resource/mcp': { method: 'GET', run: (_env, _req, url) => protectedResourceMetadata(url.origin) },
  '/.well-known/oauth-authorization-server': { method: 'GET', run: (_env, _req, url) => authorizationServerMetadata(url.origin) },
  '/oauth/authorize': { method: 'GET', run: authorize },
  '/oauth/token': { method: 'POST', run: tokenEndpoint },
  '/oauth/register': { method: 'POST', run: (env, req) => registerClient(env, req) },
  '/oauth/revoke': { method: 'POST', run: (env, req) => revokeEndpoint(env, req) },
}

/** OAuth 2.1 authorization server endpoints with RFC 6749 error bodies; null when the path is not one of them. */
export async function handleOAuth(req: Request, env: Env, url: URL): Promise<Response | null> {
  const endpoint = ENDPOINTS[url.pathname]
  if (!endpoint) return null
  const method = req.method === 'HEAD' ? 'GET' : req.method
  if (method !== endpoint.method) {
    return new Response(JSON.stringify({ error: 'invalid_request', error_description: `Use ${endpoint.method}` }), {
      status: 405,
      headers: { Allow: endpoint.method, 'Content-Type': 'application/json' },
    })
  }
  try {
    return await endpoint.run(env, req, url)
  } catch (e) {
    if (e instanceof OAuthError) return oauthJson({ error: e.error, error_description: e.message }, e.status)
    if (e instanceof ApiError) return oauthJson({ error: e.status === 429 ? 'temporarily_unavailable' : 'invalid_request', error_description: e.message }, e.status)
    console.error('oauth endpoint failed', url.pathname, e)
    return oauthJson({ error: 'server_error', error_description: 'Something went wrong' }, 500)
  }
}
