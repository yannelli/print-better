import { badRequest } from '../../http/errors'
import { HOUR } from '../../lib/time'

export interface OidcMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  id_token_signing_alg_values_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  authorization_response_iss_parameter_supported?: boolean
}

const cache = new Map<string, { at: number; meta: OidcMetadata }>()

/** OpenID Connect Discovery 1.0: the returned issuer must equal the configured one exactly. */
export async function discover(issuer: string): Promise<OidcMetadata> {
  const hit = cache.get(issuer)
  if (hit && Date.now() - hit.at < HOUR) return hit.meta
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
  let meta: OidcMetadata
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    meta = (await res.json()) as OidcMetadata
  } catch (e) {
    throw badRequest(`Could not load ${url}: ${e instanceof Error ? e.message : String(e)}`, 'oidc_discovery_failed')
  }
  const required = [meta.issuer, meta.authorization_endpoint, meta.token_endpoint, meta.jwks_uri]
  if (required.some((v) => typeof v !== 'string' || v === '')) throw badRequest('OpenID configuration is incomplete', 'oidc_discovery_failed')
  if (meta.issuer !== issuer) throw badRequest(`Issuer mismatch: configured ${issuer}, provider says ${meta.issuer}`, 'oidc_discovery_failed')
  cache.set(issuer, { at: Date.now(), meta })
  return meta
}
