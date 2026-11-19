import { adminRoutes, hookRoutes } from './api/admin-routes'
import { authRoutes } from './api/auth-routes'
import { clientRoutes, deviceRoutes } from './api/device-routes'
import { meRoutes } from './api/me-routes'
import { jobRoutes, printerRoutes } from './api/printer-routes'
import { workspaceRoutes } from './api/workspace-routes'
import { extensionRoutes } from './extensions/routes'
import { assertSameOrigin, isMutation } from './http/authenticate'
import { ApiError, errorBody, errorResponse, notFound } from './http/errors'
import { Router, toResponse, type Http } from './http/router'
import { installScript, serveDownload } from './install/serve'
import { handleMcp } from './mcp/handler'
import { consentRoutes } from './oauth/consent'
import { handleOAuth } from './oauth'

const api = new Router()
const ROUTES = [authRoutes, meRoutes, workspaceRoutes, deviceRoutes, clientRoutes, printerRoutes, jobRoutes, adminRoutes, hookRoutes, consentRoutes, extensionRoutes]
for (const register of ROUTES) register(api)

/** Login CSRF guard: browser POSTs carry an Origin, which must be ours (device and webhook calls are exempt). */
function checkCrossOrigin(h: Http): void {
  const path = h.url.pathname
  if (!isMutation(h) || path.startsWith('/api/client/') || path.startsWith('/api/hooks/') || h.req.headers.has('Authorization')) return
  assertSameOrigin(h, false)
}

async function handleApi(req: Request, env: Env, exec: ExecutionContext, url: URL): Promise<Response> {
  const h: Http = { req, url, env, exec, params: {}, cookies: [] }
  let res: Response
  try {
    checkCrossOrigin(h)
    const match = api.match(req.method, url.pathname)
    if (match === null) throw notFound(`No API route for ${url.pathname}`)
    if (match === 'method') throw new ApiError(405, 'method_not_allowed', `${req.method} is not allowed on ${url.pathname}`)
    h.params = match.params
    res = toResponse(await match.handler(h), h.cookies)
  } catch (e) {
    res = toResponse(errorResponse(e), h.cookies)
  }
  if (!res.webSocket && !res.headers.has('Cache-Control')) res.headers.set('Cache-Control', 'no-store')
  return res
}


export async function handleRequest(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname.startsWith('/api/')) return handleApi(req, env, exec, url)
  if (url.pathname === '/install.sh' || url.pathname === '/install.ps1') return installScript(url)
  if (url.pathname.startsWith('/dl/')) return serveDownload(env, req, url)
  if (url.pathname === '/mcp' || url.pathname === '/mcp/') return handleMcp(req, env, exec, url)
  const oauth = await handleOAuth(req, env, url)
  if (oauth) return oauth
  // Other /oauth/* paths (e.g. /oauth/consent) are SPA routes.
  if (url.pathname.startsWith('/mcp/') || url.pathname.startsWith('/.well-known/')) return Response.json(errorBody('not_found', 'Not found'), { status: 404 })
  return env.ASSETS.fetch(req)
}
