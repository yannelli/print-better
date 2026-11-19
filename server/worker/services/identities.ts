import type { Identity, IdentityList, SsoProviderId } from '../../shared/types'
import { conflict, forbidden, notFound } from '../http/errors'
import { all, first, run } from '../lib/db'
import { requireScope, requireSessionUser, requireUser } from './access'
import { audit } from './audit'
import type { Ctx } from './context'
import { appName, loadInstance, type Instance } from './instance-store'
import { ssoProviders } from './instance'
import { ssoClaims, verifiedEmail, type SsoState } from './sso'
import { signInMethodCount } from './users'

interface IdentityRow {
  provider: string
  subject: string
  user_id: string
  email: string | null
  created_at: number
}

const providerName = (inst: Instance, id: string): string =>
  id === 'google' ? 'Google' : (inst.config.sso.oidc.name ?? 'Single sign-on')

export async function listIdentities(ctx: Ctx): Promise<IdentityList> {
  requireScope(ctx, 'read')
  const user = requireUser(ctx)
  const [inst, rows] = await Promise.all([
    loadInstance(ctx.env),
    all<IdentityRow>(ctx.env.DB, 'SELECT * FROM identities WHERE user_id = ? ORDER BY created_at', user.id),
  ])
  const identities: Identity[] = rows.map((r) => ({
    provider: r.provider as SsoProviderId,
    providerName: providerName(inst, r.provider),
    email: r.email,
    createdAt: r.created_at,
  }))
  return { identities, available: ssoProviders(inst).map((p) => ({ provider: p.id, providerName: p.name })) }
}

/** Callback half of `?link=1`: only the session user who started the flow can finish it. */
export async function linkIdentity(ctx: Ctx, state: SsoState, params: URLSearchParams): Promise<void> {
  const signedIn = ctx.actor.type === 'user' ? ctx.actor.user : null
  if (!signedIn || signedIn.id !== state.linkUserId) {
    throw forbidden('This connection was started from a different account. Sign in again and retry.', 'sso_wrong_user')
  }
  const { provider, claims } = await ssoClaims(ctx, state, params)
  const inst = await loadInstance(ctx.env)
  const name = providerName(inst, provider.id)
  const owner = await first<IdentityRow>(ctx.env.DB, 'SELECT * FROM identities WHERE provider = ? AND subject = ?', provider.id, claims.sub)
  if (owner?.user_id === signedIn.id) return
  if (owner) {
    throw conflict(`That ${name} account is already connected to another ${appName(ctx.env, inst)} account.`, 'identity_in_use')
  }
  const mine = await first(ctx.env.DB, 'SELECT 1 AS one FROM identities WHERE provider = ? AND user_id = ?', provider.id, signedIn.id)
  if (mine) throw conflict(`You already connected a ${name} account. Disconnect it first to use a different one.`, 'identity_exists')

  const email = verifiedEmail(claims)
  await run(
    ctx.env.DB,
    'INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)',
    provider.id,
    claims.sub,
    signedIn.id,
    email,
    Date.now(),
  )
  if (email && email === signedIn.email && signedIn.email_verified !== 1) {
    await run(ctx.env.DB, 'UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ? AND email = ?', Date.now(), signedIn.id, email)
  }
  await audit(ctx, null, 'identity.link', signedIn.id, { provider: provider.id })
}

export async function unlinkIdentity(ctx: Ctx, providerId: string): Promise<void> {
  const { user } = requireSessionUser(ctx)
  const row = await first<{ n: number }>(ctx.env.DB, 'SELECT COUNT(*) AS n FROM identities WHERE provider = ? AND user_id = ?', providerId, user.id)
  const linked = row?.n ?? 0
  if (linked === 0) throw notFound('That account is not connected')
  if ((await signInMethodCount(ctx.env, user.id)) - linked < 1) {
    throw conflict('This is your only way to sign in. Add a password or a passkey first.', 'last_sign_in_method')
  }
  await run(ctx.env.DB, 'DELETE FROM identities WHERE provider = ? AND user_id = ?', providerId, user.id)
  await audit(ctx, null, 'identity.unlink', user.id, { provider: providerId })
}
