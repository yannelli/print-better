import { notFound } from '../../http/errors'
import { getSecret, loadInstance } from '../../services/instance-store'

const GOOGLE_ISSUER = 'https://accounts.google.com'

export interface Provider {
  id: 'google' | 'oidc'
  issuer: string
  /** Google also issues tokens with the scheme-less form of its issuer. */
  acceptIssuers: string[]
  clientId: string
  clientSecret: string
  extraParams: Record<string, string>
}

export async function getProvider(env: Env, id: string): Promise<Provider> {
  const inst = await loadInstance(env)
  if (id === 'google') {
    const g = inst.config.sso.google
    const secret = g.enabled && g.clientId ? await getSecret(env, 'sso.google.clientSecret') : null
    if (!g.clientId || !secret) throw notFound('Google sign-in is not enabled', 'sso_disabled')
    return {
      id,
      issuer: GOOGLE_ISSUER,
      acceptIssuers: [GOOGLE_ISSUER, 'accounts.google.com'],
      clientId: g.clientId,
      clientSecret: secret,
      extraParams: { prompt: 'select_account' },
    }
  }
  if (id === 'oidc') {
    const o = inst.config.sso.oidc
    const secret = o.enabled && o.issuer && o.clientId ? await getSecret(env, 'sso.oidc.clientSecret') : null
    if (!o.issuer || !o.clientId || !secret) throw notFound('Single sign-on is not enabled', 'sso_disabled')
    return { id, issuer: o.issuer, acceptIssuers: [o.issuer], clientId: o.clientId, clientSecret: secret, extraParams: {} }
  }
  throw notFound('Unknown sign-in provider', 'sso_disabled')
}
