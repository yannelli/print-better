import { discover, type OidcMetadata } from '../auth/oidc/discovery'
import { verifyIdToken, type IdClaims } from '../auth/oidc/jwt'
import { getProvider, type Provider } from '../auth/oidc/providers'
import type { UserRow } from '../db/rows'
import { badRequest, conflict, forbidden } from '../http/errors'
import { putChallenge, takeChallenge } from '../lib/challenges'
import { randomBytes, safeEqual, sha256, sha256Hex } from '../lib/crypto'
import { first, run } from '../lib/db'
import { b64, b64url } from '../lib/encoding'
import { MINUTE } from '../lib/time'
import { requireSessionUser } from './access'
import { signIn } from './accounts'
import { audit } from './audit'
import { asUser, type Ctx } from './context'
import { loadInstance } from './instance-store'
import { findInvite, joinWithInvite } from './invites'
import { freeUsername, insertUser } from './users'

export interface SsoState {
  provider: string
  verifier: string
  nonce: string
  next: string
  invite: string | null
  /** Set when a signed-in user is connecting this provider rather than signing in. */
  linkUserId?: string | null
}

/** Only same-origin absolute paths, so the callback cannot be turned into an open redirect. */
export function safeNext(next: string | null | undefined): string {
  if (!next || next.length > 500 || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  return next
}

const redirectUri = (ctx: Ctx, provider: string) => `${ctx.origin}/api/auth/sso/${provider}/callback`

export const SSO_TTL = 10 * MINUTE

export interface StartOptions {
  next: string | null
  invite: string | null
  /** Connect the provider to the signed-in session user instead of signing in. */
  link?: boolean
}

/** Authorization-code flow with PKCE (S256) and nonce kept server side; the caller binds `state` to the browser. */
export async function ssoStart(ctx: Ctx, providerId: string, o: StartOptions): Promise<{ url: string; state: string }> {
  const linkUserId = o.link ? requireSessionUser(ctx).user.id : null
  const provider = await getProvider(ctx.env, providerId)
  const meta = await discover(provider.issuer)
  const state = b64url(randomBytes(32))
  const data: SsoState = {
    provider: provider.id,
    verifier: b64url(randomBytes(32)),
    nonce: b64url(randomBytes(16)),
    next: safeNext(o.next),
    invite: o.link ? null : o.invite,
    linkUserId,
  }
  await putChallenge(ctx.env, await sha256Hex(state), 'oidc', null, data, SSO_TTL)
  const url = new URL(meta.authorization_endpoint)
  const params = {
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: redirectUri(ctx, provider.id),
    scope: 'openid email profile',
    state,
    nonce: data.nonce,
    code_challenge: b64url(await sha256(data.verifier)),
    code_challenge_method: 'S256',
    ...provider.extraParams,
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return { url: url.toString(), state }
}

async function exchangeCode(ctx: Ctx, provider: Provider, meta: OidcMetadata, code: string, verifier: string): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(ctx, provider.id), code_verifier: verifier })
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  const methods = meta.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
  if (methods.includes('client_secret_basic')) {
    const id = encodeURIComponent(provider.clientId)
    const secret = encodeURIComponent(provider.clientSecret)
    headers.Authorization = `Basic ${b64(new TextEncoder().encode(`${id}:${secret}`))}`
  } else {
    body.set('client_id', provider.clientId)
    body.set('client_secret', provider.clientSecret)
  }
  const res = await fetch(meta.token_endpoint, { method: 'POST', headers, body })
  const json = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string }
  if (!res.ok || !json.id_token) throw badRequest(json.error_description ?? json.error ?? 'The sign-in provider rejected the code', 'sso_failed')
  return json.id_token
}

/** `browserState` is the state cookie set by the start route; without a match the response belongs to another browser. */
export async function takeSsoState(ctx: Ctx, providerId: string, params: URLSearchParams, browserState: string | null): Promise<SsoState> {
  const state = params.get('state')
  const bound = state !== null && browserState !== null && safeEqual(state, browserState)
  const found = bound ? await takeChallenge<SsoState>(ctx.env, 'oidc', await sha256Hex(state)) : null
  if (!found || found.data.provider !== providerId) throw badRequest('This sign-in attempt expired or began in another browser. Try again.', 'sso_expired')
  return found.data
}

/** Exchanges the code and returns the verified ID token claims. */
export async function ssoClaims(ctx: Ctx, state: SsoState, params: URLSearchParams): Promise<{ provider: Provider; claims: IdClaims }> {
  const error = params.get('error')
  if (error) throw badRequest(params.get('error_description') ?? 'Sign-in was cancelled', `sso_${error}`)
  const provider = await getProvider(ctx.env, state.provider)
  const meta = await discover(provider.issuer)
  // RFC 9207: a present iss must match; providers that advertise support must send it.
  const iss = params.get('iss')
  if ((iss !== null && iss !== meta.issuer) || (iss === null && meta.authorization_response_iss_parameter_supported)) {
    throw badRequest('The sign-in response came from an unexpected issuer', 'sso_failed')
  }
  const code = params.get('code')
  if (!code) throw badRequest('The sign-in provider sent no code', 'sso_failed')
  const idToken = await exchangeCode(ctx, provider, meta, code, state.verifier)
  const claims = await verifyIdToken(idToken, { jwksUri: meta.jwks_uri, issuers: provider.acceptIssuers, clientId: provider.clientId, nonce: state.nonce })
  return { provider, claims }
}

/** Returns the `pbs_` session token for the account the provider vouches for. */
export async function ssoSignIn(ctx: Ctx, state: SsoState, params: URLSearchParams): Promise<string> {
  const { provider, claims } = await ssoClaims(ctx, state, params)
  const user = await resolveUser(ctx, provider, claims, state.invite)
  return (await signIn(ctx, user)).sessionToken
}

export const verifiedEmail = (c: IdClaims): string | null =>
  typeof c.email === 'string' && (c.email_verified === true || c.email_verified === 'true') ? c.email.toLowerCase() : null

/** Existing link, else link by verified email (both sides verified), else a new account via invite or open sign-up. */
async function resolveUser(ctx: Ctx, provider: Provider, claims: IdClaims, inviteToken: string | null): Promise<UserRow> {
  const linked = await first<UserRow>(
    ctx.env.DB,
    'SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?',
    provider.id,
    claims.sub,
  )
  if (linked) return linked
  const email = verifiedEmail(claims)
  const link = (user: UserRow) =>
    run(ctx.env.DB, 'INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)', provider.id, claims.sub, user.id, email, Date.now())

  const sameEmail = email ? await first<UserRow>(ctx.env.DB, 'SELECT * FROM users WHERE email = ?', email) : null
  if (sameEmail) {
    if (sameEmail.email_verified !== 1) {
      throw conflict('An account with this email exists but its email is not verified. Sign in another way first.', 'sso_unverified_account')
    }
    await link(sameEmail)
    await audit(asUser(ctx, sameEmail), null, 'identity.link', sameEmail.id, { provider: provider.id })
    return sameEmail
  }

  const invite = inviteToken ? await findInvite(ctx.env, inviteToken) : null
  if (!invite && (await loadInstance(ctx.env)).config.signup !== 'open') {
    throw forbidden('No account uses this sign-in yet. Ask an admin for an invite.', 'signup_closed')
  }
  const user = await insertUser(ctx.env, {
    username: await freeUsername(ctx.env, email ?? claims.name ?? 'user'),
    name: (claims.name ?? email ?? 'New user').slice(0, 100),
    email,
    emailVerified: email !== null,
    passwordHash: null,
    isAdmin: false,
  })
  if (!user) throw new Error('user insert returned no row')
  await link(user)
  if (invite) await joinWithInvite(asUser(ctx, user), invite, user.id)
  return user
}
