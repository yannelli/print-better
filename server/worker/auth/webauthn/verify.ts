// WebAuthn Level 3 registration (7.1) and assertion (7.2) checks over `PublicKeyCredential.toJSON()` input.
import type { Json } from '../../http/body'
import { badRequest } from '../../http/errors'
import { isObj } from '../../http/validate'
import { safeEqual, sha256 } from '../../lib/crypto'
import { b64url, concatBytes, fromB64url, fromUtf8 } from '../../lib/encoding'
import { asMap, decodeCbor, type Cbor } from './cbor'
import { coseToSpki, importSpki, SUPPORTED_ALGS, verifySignature } from './keys'

export interface Expected {
  challenge: string
  origin: string
  rpId: string
}

export interface NewCredential {
  id: string
  publicKey: string
  alg: number
  signCount: number
  backedUp: boolean
  transports: string[]
}

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40

const fail = (reason: string) => badRequest(`Passkey verification failed: ${reason}`, 'passkey_invalid')

interface AuthData {
  rpIdHash: Uint8Array
  flags: number
  signCount: number
  credentialId: Uint8Array | null
  coseKey: Map<Cbor, Cbor> | null
}

function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw fail('authenticator data is too short')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const base = { rpIdHash: data.subarray(0, 32), flags: data[32], signCount: view.getUint32(33) }
  if (!(base.flags & AT)) return { ...base, credentialId: null, coseKey: null }
  if (data.length < 55) throw fail('attested credential data is truncated')
  const idLength = view.getUint16(53)
  if (idLength > 1023 || data.length < 55 + idLength) throw fail('credential id is not valid')
  try {
    const { value } = decodeCbor(data, 55 + idLength)
    return { ...base, credentialId: data.slice(55, 55 + idLength), coseKey: asMap(value, 'credential public key') }
  } catch (e) {
    throw fail(e instanceof Error ? e.message : 'credential public key is not valid')
  }
}

function field(obj: Json, key: string): Uint8Array<ArrayBuffer> {
  const v = obj[key]
  if (typeof v !== 'string') throw fail(`${key} is missing`)
  try {
    return fromB64url(v)
  } catch {
    throw fail(`${key} is not base64url`)
  }
}

function parts(credential: unknown): { id: string; response: Json } {
  if (!isObj(credential) || credential.type !== 'public-key' || typeof credential.id !== 'string' || !isObj(credential.response)) {
    throw fail('credential must be PublicKeyCredential JSON')
  }
  return { id: credential.id, response: credential.response }
}

function checkClientData(raw: Uint8Array, type: string, expected: Expected): void {
  let data: Json
  try {
    data = JSON.parse(fromUtf8(raw)) as Json
  } catch {
    throw fail('clientDataJSON is not JSON')
  }
  if (data.type !== type) throw fail('wrong ceremony type')
  if (data.challenge !== expected.challenge) throw fail('challenge mismatch')
  if (data.origin !== expected.origin) throw fail('origin mismatch')
  if (data.crossOrigin === true) throw fail('cross-origin ceremonies are not allowed')
}

async function checkAuthData(ad: AuthData, expected: Expected): Promise<void> {
  if (!safeEqual(ad.rpIdHash, await sha256(expected.rpId))) throw fail('RP ID mismatch')
  if (!(ad.flags & UP)) throw fail('user presence is missing')
  if (!(ad.flags & UV)) throw fail('user verification is missing')
  if (!(ad.flags & BE) && ad.flags & BS) throw fail('backup flags are inconsistent')
}

export async function verifyRegistration(credential: unknown, expected: Expected): Promise<NewCredential> {
  const { id, response } = parts(credential)
  checkClientData(field(response, 'clientDataJSON'), 'webauthn.create', expected)
  let authData: Uint8Array
  if (typeof response.authenticatorData === 'string') authData = field(response, 'authenticatorData')
  else {
    const attestation = asMap(decodeCbor(field(response, 'attestationObject')).value, 'attestationObject')
    const raw = attestation.get('authData')
    if (!(raw instanceof Uint8Array)) throw fail('attestationObject has no authData')
    authData = raw
  }
  const ad = parseAuthData(authData)
  await checkAuthData(ad, expected)
  if (!ad.credentialId) throw fail('attested credential data is missing')
  if (b64url(ad.credentialId) !== id) throw fail('credential id mismatch')

  let spki: Uint8Array<ArrayBuffer>
  let alg: number
  if (typeof response.publicKey === 'string' && typeof response.publicKeyAlgorithm === 'number') {
    spki = field(response, 'publicKey')
    alg = response.publicKeyAlgorithm
  } else {
    if (!ad.coseKey) throw fail('credential public key is missing')
    const parsed = await coseToSpki(ad.coseKey).catch((e: unknown) => {
      throw fail(e instanceof Error ? e.message : 'credential public key is not valid')
    })
    spki = parsed.spki
    alg = parsed.alg
  }
  if (!SUPPORTED_ALGS.includes(alg)) throw fail(`algorithm ${alg} is not supported`)
  await importSpki(alg, spki).catch(() => {
    throw fail('public key does not match its algorithm')
  })
  const transports = Array.isArray(response.transports) ? response.transports.filter((t): t is string => typeof t === 'string') : []
  return { id, publicKey: b64url(spki), alg, signCount: ad.signCount, backedUp: (ad.flags & BS) !== 0, transports }
}

export interface StoredKey {
  publicKey: string
  alg: number
  signCount: number
}

/** `cloned` flags a non-increasing counter; synced passkeys report 0 forever, which is allowed. */
export async function verifyAssertion(
  credential: unknown,
  expected: Expected,
  stored: StoredKey,
): Promise<{ signCount: number; backedUp: boolean; cloned: boolean }> {
  const { response } = parts(credential)
  const clientData = field(response, 'clientDataJSON')
  checkClientData(clientData, 'webauthn.get', expected)
  const authData = field(response, 'authenticatorData')
  const ad = parseAuthData(authData)
  await checkAuthData(ad, expected)
  const signed = concatBytes(authData, await sha256(clientData))
  const ok = await verifySignature(stored.alg, fromB64url(stored.publicKey), field(response, 'signature'), signed).catch(() => false)
  if (!ok) throw fail('signature is not valid')
  const cloned = (ad.signCount !== 0 || stored.signCount !== 0) && ad.signCount <= stored.signCount
  return { signCount: Math.max(ad.signCount, stored.signCount), backedUp: (ad.flags & BS) !== 0, cloned }
}

export function credentialId(credential: unknown): string {
  return parts(credential).id
}

/** The user handle we issued is the UTF-8 user id; returns null when the authenticator sent none. */
export function userHandle(credential: unknown): string | null {
  const { response } = parts(credential)
  if (typeof response.userHandle !== 'string' || response.userHandle === '') return null
  return fromUtf8(field(response, 'userHandle'))
}
