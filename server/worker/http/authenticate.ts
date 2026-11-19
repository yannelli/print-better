import { lookupSession, SESSION_TTL } from '../auth/sessions'
import { bearerToken, lookupApiToken, lookupClient } from '../auth/tokens'
import type { ClientRow } from '../db/rows'
import { run } from '../lib/db'
import { MINUTE } from '../lib/time'
import type { Actor, Ctx } from '../services/context'
import { clearSessionCookie, readCookie, SESSION_COOKIE, sessionCookie } from './cookies'
import { forbidden, unauthorized } from './errors'
import type { Http } from './router'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Cookie-authenticated requests that change state (or open a WebSocket) must come from our own origin. */
export function assertSameOrigin(h: Http, required: boolean): void {
  const origin = h.req.headers.get('Origin')
  if (origin === null) {
    if (required) throw forbidden('Missing Origin header', 'bad_origin')
    return
  }
  if (origin !== h.url.origin) throw forbidden('Cross-origin request rejected', 'bad_origin')
}

export const isMutation = (h: Http): boolean => !SAFE_METHODS.has(h.req.method)
const isUpgrade = (h: Http): boolean => h.req.headers.get('Upgrade')?.toLowerCase() === 'websocket'

async function authenticate(h: Http): Promise<Actor> {
  const token = bearerToken(h.req)
  if (h.req.headers.has('Authorization')) {
    // OAuth access tokens are audience-bound to /mcp (RFC 8707), so the REST API takes only personal tokens.
    const found = token?.startsWith('pbt_') ? await lookupApiToken(h.env, token, (p) => h.exec.waitUntil(p)) : null
    if (!found) throw unauthorized('Invalid or expired token', 'invalid_token')
    return { type: 'token', user: found.user, tokenId: found.tokenId, workspaceId: found.workspaceId, scopes: found.scopes }
  }
  const cookie = readCookie(h.req, SESSION_COOKIE)
  if (!cookie) return { type: 'anonymous' }
  const session = await lookupSession(h.env, cookie)
  if (!session) {
    h.cookies.push(clearSessionCookie())
    return { type: 'anonymous' }
  }
  if (isMutation(h) || isUpgrade(h)) assertSameOrigin(h, true)
  if (session.refreshed) h.cookies.push(sessionCookie(cookie, SESSION_TTL))
  return { type: 'user', user: session.user, sessionId: session.sessionId }
}

function buildCtx(h: Http, actor: Actor): Ctx {
  return {
    env: h.env,
    actor,
    origin: h.url.origin,
    ip: h.req.headers.get('CF-Connecting-IP'),
    userAgent: h.req.headers.get('User-Agent'),
    waitUntil: (p) => h.exec.waitUntil(p),
  }
}

const cache = new WeakMap<Http, Promise<Ctx>>()

/** Authenticates the request once (session cookie or bearer token) and returns the service context. */
export function ctxOf(h: Http): Promise<Ctx> {
  let ctx = cache.get(h)
  if (!ctx) {
    ctx = authenticate(h).then((actor) => buildCtx(h, actor))
    cache.set(h, ctx)
  }
  return ctx
}

/** Context for public endpoints that never look at credentials. */
export const publicCtx = (h: Http): Ctx => buildCtx(h, { type: 'anonymous' })

/** Device endpoints: `Authorization: Bearer pbc_…`. */
export async function requireClient(h: Http): Promise<ClientRow> {
  const token = bearerToken(h.req)
  const client = token ? await lookupClient(h.env, token) : null
  if (!client) throw unauthorized('Unknown or revoked device token', 'invalid_token')
  touchLastSeen(h, client)
  return client
}

/** Devices without a socket (phones) show when they were last used; the hub keeps connected ones current. */
function touchLastSeen(h: Http, client: ClientRow): void {
  const now = Date.now()
  if (client.online === 1 || (client.last_seen_at !== null && now - client.last_seen_at < MINUTE)) return
  h.exec.waitUntil(run(h.env.DB, 'UPDATE clients SET last_seen_at = ? WHERE id = ? AND online = 0', now, client.id))
}

export const clientCtx = (h: Http, client: ClientRow): Ctx => buildCtx(h, { type: 'client', client })
