import { b64url } from './authenticator'
import { Agent, ORIGIN } from './http'
import { routeFetch, type FetchHandler } from './outbound'

let count = 0
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>

export interface IdpOptions {
  issuer?: string
  clientId?: string
  /** RFC 9207: advertise and send the `iss` authorization response parameter. */
  issParam?: boolean
  authMethods?: string[]
  alg?: 'ES256' | 'RS256'
}

interface Pending {
  challenge: string | null
  redirectUri: string | null
  nonce: string | null
  claims: Record<string, unknown>
}

const ALGS = {
  ES256: { gen: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
  RS256: {
    gen: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    sign: { name: 'RSASSA-PKCS1-v1_5' },
  },
} as const

/** An OpenID provider behind the outbound fetch stub: discovery, JWKS, and a token endpoint that enforces PKCE. */
export class FakeIdp {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret = 'idp-client-secret'
  readonly tokenCalls: { auth: string | null; form: URLSearchParams }[] = []
  discoveryStatus = 200
  metadataOverrides: Record<string, unknown> = {}
  tokenHeader: Record<string, unknown> = {}
  tokenError: Record<string, string> | null = null
  mangle: ((jwt: string) => string) | null = null
  private codes = new Map<string, Pending>()

  private constructor(
    private keys: CryptoKeyPair,
    private jwk: JsonWebKey,
    private opts: IdpOptions,
  ) {
    count += 1
    this.issuer = opts.issuer ?? `https://idp${count}.example`
    this.clientId = opts.clientId ?? 'print-better'
  }

  static async create(opts: IdpOptions = {}): Promise<FakeIdp> {
    const keys = (await crypto.subtle.generateKey(ALGS[opts.alg ?? 'ES256'].gen, true, ['sign', 'verify'])) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey
    return new FakeIdp(keys, jwk, opts)
  }

  metadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      jwks_uri: `${this.issuer}/jwks`,
      id_token_signing_alg_values_supported: [this.opts.alg ?? 'ES256'],
      token_endpoint_auth_methods_supported: this.opts.authMethods ?? ['client_secret_basic', 'client_secret_post'],
      ...(this.opts.issParam ? { authorization_response_iss_parameter_supported: true } : {}),
      ...this.metadataOverrides,
    }
  }

  routes(): Record<string, FetchHandler> {
    const { kty, n, e, crv, x, y } = this.jwk
    return {
      [`${this.issuer}/.well-known/openid-configuration`]: () =>
        this.discoveryStatus === 200 ? Response.json(this.metadata()) : new Response('unavailable', { status: this.discoveryStatus }),
      [`${this.issuer}/jwks`]: () => Response.json({ keys: [{ kty, n, e, crv, x, y, kid: 'k1', use: 'sig', alg: this.opts.alg ?? 'ES256' }] }),
      [`${this.issuer}/token`]: (req) => this.token(req),
    }
  }

  /** The provider's side of the browser redirect: the user approves and is sent back with a code. */
  approve(authorizeUrl: string, claims: Record<string, unknown> = {}): URLSearchParams {
    const q = new URL(authorizeUrl).searchParams
    const code = crypto.randomUUID()
    this.codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), nonce: q.get('nonce'), claims })
    const out = new URLSearchParams({ code, state: q.get('state') ?? '' })
    if (this.opts.issParam) out.set('iss', this.issuer)
    return out
  }

  async sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
    const part = (o: unknown) => b64url(utf8(JSON.stringify(o)))
    const input = `${part({ alg: this.opts.alg ?? 'ES256', typ: 'JWT', kid: 'k1', ...header })}.${part(claims)}`
    const sig = await crypto.subtle.sign(ALGS[this.opts.alg ?? 'ES256'].sign, this.keys.privateKey, utf8(input))
    return `${input}.${b64url(new Uint8Array(sig))}`
  }

  private async token(req: Request): Promise<Response> {
    const form = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()))
    this.tokenCalls.push({ auth: req.headers.get('Authorization'), form })
    if (this.tokenError) return Response.json(this.tokenError, { status: 400 })
    const code = form.get('code') ?? ''
    const pending = this.codes.get(code)
    this.codes.delete(code)
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(form.get('code_verifier') ?? ''))))
    const clientOk = req.headers.has('Authorization')
      ? req.headers.get('Authorization') === `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`
      : form.get('client_id') === this.clientId && form.get('client_secret') === this.clientSecret
    if (!pending || !clientOk || pending.redirectUri !== form.get('redirect_uri') || pending.challenge !== challenge) {
      return Response.json({ error: 'invalid_grant', error_description: 'Code, client or PKCE verifier rejected' }, { status: 400 })
    }
    const now = Math.floor(Date.now() / 1000)
    const claims = { iss: this.issuer, sub: 'subject-1', aud: this.clientId, exp: now + 300, iat: now, nonce: pending.nonce, ...pending.claims }
    const idToken = await this.sign(claims, this.tokenHeader)
    return Response.json({ access_token: 'opaque', token_type: 'Bearer', expires_in: 300, id_token: this.mangle ? this.mangle(idToken) : idToken })
  }
}

/** Serves every given provider through the outbound fetch stub. */
export const serve = (...idps: FakeIdp[]) => routeFetch(Object.assign({}, ...idps.map((i) => i.routes())))

/** Makes `idp` the instance's generic OIDC provider; discovery is fetched during the PATCH. */
export async function useIdp(admin: Agent, idp: FakeIdp, ...alsoServe: FakeIdp[]): Promise<void> {
  serve(idp, ...alsoServe)
  const r = await admin.patch('/api/admin/settings', { sso: { oidc: { enabled: true, name: 'Acme SSO', issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret } } })
  if (r.status !== 200) throw new Error(`configuring ${idp.issuer} failed: ${r.status} ${JSON.stringify(r.body)}`)
}

export interface FlowOptions {
  provider?: string
  next?: string
  invite?: string
  claims?: Record<string, unknown>
  /** Alters the callback query (state, iss, error, …) before the browser returns. */
  edit?: (query: URLSearchParams) => void
}

/** start → provider approval → callback, all in `browser`. */
export async function ssoFlow(browser: Agent, idp: FakeIdp, o: FlowOptions = {}): Promise<{ start: Response; callback: Response; query: URLSearchParams }> {
  const provider = o.provider ?? 'oidc'
  const q = new URLSearchParams()
  if (o.next !== undefined) q.set('next', o.next)
  if (o.invite !== undefined) q.set('invite', o.invite)
  const start = await browser.fetch(`/api/auth/sso/${provider}/start?${q}`)
  const location = start.headers.get('Location') ?? ''
  if (start.status !== 302 || !location.startsWith(idp.issuer)) throw new Error(`start did not reach the provider: ${start.status} ${location}`)
  const query = idp.approve(location, o.claims)
  o.edit?.(query)
  const callback = await browser.fetch(`/api/auth/sso/${provider}/callback?${query}`)
  return { start, callback, query }
}

/** Where a redirect points, relative to the app origin. */
export function redirectTarget(res: Response): URL {
  if (res.status !== 302) throw new Error(`expected a redirect, got ${res.status}`)
  return new URL(res.headers.get('Location') ?? '', ORIGIN)
}

/** The `/login?error=…&message=…` redirect SSO failures produce. */
export function loginError(res: Response): { path: string; error: string | null; message: string | null } {
  const url = redirectTarget(res)
  return { path: url.pathname, error: url.searchParams.get('error'), message: url.searchParams.get('message') }
}
