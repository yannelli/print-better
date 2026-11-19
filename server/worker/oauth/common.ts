import { DAY, HOUR, MINUTE } from '../lib/time'
import { SCOPES, type Scope } from '../services/access'

export { SCOPES, type Scope }

export const ACCESS_TTL = HOUR
export const REFRESH_TTL = 30 * DAY
export const CODE_TTL = 5 * MINUTE
export const REQUEST_TTL = 10 * MINUTE

/** The only protected resource: tokens are minted for, and accepted by, `<origin>/mcp`. */
export const mcpResource = (origin: string): string => `${origin}/mcp`
export const isMcpResource = (resource: string, origin: string): boolean =>
  resource === mcpResource(origin) || resource === `${mcpResource(origin)}/`

/** RFC 6749 error, rendered as `{ error, error_description }`. */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description: string,
  ) {
    super(description)
  }
}

export const invalidGrant = (description: string): OAuthError => new OAuthError(400, 'invalid_grant', description)

export function oauthJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } })
}

/** Requested scopes we support; asking for none of them grants all three. */
export function grantedScopes(scope: string | null): Scope[] {
  const asked = new Set((scope ?? '').split(' ').filter(Boolean))
  const granted = SCOPES.filter((s) => asked.has(s))
  return granted.length > 0 ? granted : [...SCOPES]
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
export const isLoopback = (url: URL): boolean => url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)

const parse = (raw: string): URL | null => {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

const UNSAFE_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:'])

/** HTTPS, loopback HTTP, or a native app's private-use scheme; never a fragment. */
export function validRedirectUri(raw: string): boolean {
  const url = parse(raw)
  if (!url || url.hash || raw.length > 500) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return isLoopback(url)
  return !UNSAFE_SCHEMES.has(url.protocol)
}

/** Exact match, except loopback redirects may use any port (RFC 8252 §7.3). */
export function redirectAllowed(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  const want = parse(requested)
  if (!want || !isLoopback(want) || want.hash) return false
  return registered.some((r) => {
    const have = parse(r)
    return !!have && isLoopback(have) && have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search
  })
}

/** Appends parameters to a redirect URI, keeping its own query. */
export function withParams(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v)
  return url.toString()
}

/** Public clients send `client_id` in the form; some use HTTP Basic with an empty secret instead. */
export function clientIdOf(req: Request, form: URLSearchParams): string | null {
  const fromForm = form.get('client_id')
  if (fromForm) return fromForm
  const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '')
  if (!basic) return null
  try {
    return decodeURIComponent(atob(basic[1]).split(':')[0]) || null
  } catch {
    return null
  }
}
