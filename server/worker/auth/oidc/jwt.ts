import { badRequest } from '../../http/errors'
import { fromB64url, fromUtf8, utf8 } from '../../lib/encoding'
import { MINUTE } from '../../lib/time'

export interface IdClaims {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat?: number
  nonce?: string
  azp?: string
  email?: string
  email_verified?: boolean | string
  name?: string
}

interface Jwk {
  kid?: string
  kty: string
  n?: string
  e?: string
  crv?: string
  x?: string
  y?: string
}

const ALGS: Record<string, { kty: string; importAlg: SubtleCryptoImportKeyAlgorithm; verifyAlg: SubtleCryptoSignAlgorithm }> = {
  RS256: { kty: 'RSA', importAlg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyAlg: { name: 'RSASSA-PKCS1-v1_5' } },
  ES256: { kty: 'EC', importAlg: { name: 'ECDSA', namedCurve: 'P-256' }, verifyAlg: { name: 'ECDSA', hash: 'SHA-256' } },
}

const jwksCache = new Map<string, { keys: Jwk[]; expires: number; fetchedAt: number }>()
const fail = (reason: string) => badRequest(`Sign-in token rejected: ${reason}`, 'sso_invalid_token')

async function fetchJwks(uri: string): Promise<Jwk[]> {
  const res = await fetch(uri, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw fail(`could not load signing keys (HTTP ${res.status})`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '')?.[1] ?? 3600)
  const now = Date.now()
  const keys = Array.isArray(body.keys) ? body.keys : []
  jwksCache.set(uri, { keys, expires: now + Math.min(Math.max(maxAge, 60), 86_400) * 1000, fetchedAt: now })
  return keys
}

/** Cached JWKS honoring max-age; an unknown `kid` triggers at most one refetch per minute (key rotation). */
async function findKey(uri: string, kid: string | undefined, kty: string): Promise<Jwk | null> {
  const pick = (keys: Jwk[]) => keys.find((k) => k.kty === kty && (kid === undefined || k.kid === kid)) ?? null
  const cached = jwksCache.get(uri)
  const now = Date.now()
  if (cached && cached.expires > now) {
    const key = pick(cached.keys)
    if (key || now - cached.fetchedAt < MINUTE) return key
  }
  return pick(await fetchJwks(uri))
}

const decodePart = <T>(part: string): T => {
  try {
    return JSON.parse(fromUtf8(fromB64url(part))) as T
  } catch {
    throw fail('malformed token')
  }
}

export async function verifyIdToken(
  token: string,
  opts: { jwksUri: string; issuers: string[]; clientId: string; nonce: string },
): Promise<IdClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw fail('malformed token')
  const header = decodePart<{ alg?: string; kid?: string }>(parts[0])
  const alg = ALGS[header.alg ?? '']
  if (!alg) throw fail(`unsupported algorithm ${header.alg}`)
  const jwk = await findKey(opts.jwksUri, header.kid, alg.kty)
  if (!jwk) throw fail('signing key not found')
  const minimal: JsonWebKey = alg.kty === 'RSA' ? { kty: 'RSA', n: jwk.n, e: jwk.e } : { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }
  const key = await crypto.subtle.importKey('jwk', minimal, alg.importAlg, false, ['verify']).catch(() => {
    throw fail('signing key is not usable')
  })
  const valid = await crypto.subtle.verify(alg.verifyAlg, key, fromB64url(parts[2]), utf8(`${parts[0]}.${parts[1]}`))
  if (!valid) throw fail('bad signature')

  const claims = decodePart<IdClaims>(parts[1])
  const now = Date.now() / 1000
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!opts.issuers.includes(claims.iss)) throw fail('wrong issuer')
  if (!aud.includes(opts.clientId)) throw fail('wrong audience')
  if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== opts.clientId) throw fail('wrong authorized party')
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw fail('expired')
  if (typeof claims.iat === 'number' && claims.iat > now + 300) throw fail('issued in the future')
  if (claims.nonce !== opts.nonce) throw fail('nonce mismatch')
  if (typeof claims.sub !== 'string' || claims.sub === '') throw fail('missing subject')
  return claims
}
