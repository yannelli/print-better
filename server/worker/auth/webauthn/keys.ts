import { b64url } from '../../lib/encoding'
import type { Cbor } from './cbor'

export const ES256 = -7
export const EDDSA = -8
export const RS256 = -257
export const SUPPORTED_ALGS = [EDDSA, ES256, RS256]

function importParams(alg: number): SubtleCryptoImportKeyAlgorithm {
  if (alg === ES256) return { name: 'ECDSA', namedCurve: 'P-256' }
  if (alg === EDDSA) return { name: 'Ed25519' }
  if (alg === RS256) return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
  throw new Error(`unsupported COSE algorithm ${alg}`)
}

/** COSE_Key (RFC 9053 / 8230) to SPKI DER, for browsers whose credential JSON lacks `publicKey`. */
export async function coseToSpki(cose: Map<Cbor, Cbor>): Promise<{ spki: Uint8Array<ArrayBuffer>; alg: number }> {
  const alg = cose.get(3)
  const kty = cose.get(1)
  const field = (label: number): string => {
    const v = cose.get(label)
    if (!(v instanceof Uint8Array)) throw new Error(`COSE key is missing label ${label}`)
    return b64url(v)
  }
  let jwk: JsonWebKey
  if (alg === ES256 && kty === 2 && cose.get(-1) === 1) jwk = { kty: 'EC', crv: 'P-256', x: field(-2), y: field(-3) }
  else if (alg === EDDSA && kty === 1 && cose.get(-1) === 6) jwk = { kty: 'OKP', crv: 'Ed25519', x: field(-2) }
  else if (alg === RS256 && kty === 3) jwk = { kty: 'RSA', n: field(-1), e: field(-2), alg: 'RS256' }
  else throw new Error('unsupported COSE key')
  const key = await crypto.subtle.importKey('jwk', jwk, importParams(alg), true, ['verify'])
  return { spki: new Uint8Array((await crypto.subtle.exportKey('spki', key)) as ArrayBuffer), alg }
}

/** ASN.1 DER `SEQUENCE { r INTEGER, s INTEGER }` to the IEEE P1363 `r || s` form WebCrypto verifies. */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array<ArrayBuffer> {
  let pos = 0
  const expect = (tag: number) => {
    if (der[pos++] !== tag) throw new Error('malformed DER signature')
  }
  const length = (): number => {
    let len = der[pos++]
    if (len & 0x80) {
      const n = len & 0x7f
      len = 0
      for (let i = 0; i < n; i++) len = (len << 8) | der[pos++]
    }
    return len
  }
  expect(0x30)
  length()
  const out = new Uint8Array(size * 2)
  for (let part = 0; part < 2; part++) {
    expect(0x02)
    const len = length()
    let value = der.subarray(pos, pos + len)
    pos += len
    while (value.length > size && value[0] === 0) value = value.subarray(1)
    if (value.length > size || pos > der.length) throw new Error('malformed DER signature')
    out.set(value, part * size + (size - value.length))
  }
  return out
}

export async function importSpki(alg: number, spki: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', spki, importParams(alg), false, ['verify'])
}

export async function verifySignature(
  alg: number,
  spki: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const key = await importSpki(alg, spki)
  if (alg === ES256) return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), data)
  if (alg === EDDSA) return crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data)
  return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, data)
}
