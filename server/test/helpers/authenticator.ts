import { ORIGIN } from './http'

export const UP = 0x01
export const UV = 0x04
export const BE = 0x08
export const BS = 0x10
export const AT = 0x40

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const sha256 = async (data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', data))

export type CborValue = number | string | Uint8Array | CborValue[] | Map<CborValue, CborValue>

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n]
  if (n < 0x100) return [(major << 5) | 24, n]
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff]
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

/** Definite-length CBOR for the handful of types CTAP2 uses. */
export function cbor(value: CborValue): Uint8Array {
  const out: number[] = []
  const put = (v: CborValue): void => {
    if (typeof v === 'number') out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)))
    else if (typeof v === 'string') {
      const bytes = utf8(v)
      out.push(...head(3, bytes.length), ...bytes)
    } else if (v instanceof Uint8Array) out.push(...head(2, v.length), ...v)
    else if (Array.isArray(v)) {
      out.push(...head(4, v.length))
      v.forEach(put)
    } else {
      out.push(...head(5, v.size))
      for (const [k, item] of v) {
        put(k)
        put(item)
      }
    }
  }
  put(value)
  return new Uint8Array(out)
}

/** WebCrypto ECDSA yields IEEE P1363 `r || s`; WebAuthn assertions carry ASN.1 DER. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array): number[] => {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    const trimmed = [...bytes.subarray(i)]
    if (trimmed[0] & 0x80) trimmed.unshift(0)
    return [0x02, trimmed.length, ...trimmed]
  }
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))]
  return new Uint8Array([0x30, body.length, ...body])
}

export interface CeremonyOverrides {
  origin?: string
  rpId?: string
  challenge?: string
  type?: string
  crossOrigin?: boolean
  flags?: number
  signCount?: number
}

export interface RegisterOverrides extends CeremonyOverrides {
  /** Reported credential id, to test a mismatch with the attested one. */
  id?: string
}

export interface AssertOverrides extends CeremonyOverrides {
  /** null omits the user handle; a string replaces it (base64url). */
  userHandle?: string | null
  tamper?: boolean
}

interface CreationOptions {
  challenge: string
  rp: { id: string }
  user: { id: string }
}

interface RequestOptions {
  challenge: string
  rpId: string
}

/** A software ES256 platform authenticator producing `PublicKeyCredential.toJSON()` shapes. */
export class Authenticator {
  readonly rawId: Uint8Array
  signCount = 0
  userHandle: string | null = null

  private constructor(private keys: CryptoKeyPair, private cose: Uint8Array) {
    this.rawId = crypto.getRandomValues(new Uint8Array(32))
  }

  static async create(): Promise<Authenticator> {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey
    const cose = cbor(new Map<CborValue, CborValue>([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x ?? '')], [-3, fromB64url(jwk.y ?? '')]]))
    return new Authenticator(keys, cose)
  }

  get id(): string {
    return b64url(this.rawId)
  }

  private async authData(rpId: string, flags: number, signCount: number, attested: boolean): Promise<Uint8Array> {
    const counter = new Uint8Array([(signCount >>> 24) & 0xff, (signCount >>> 16) & 0xff, (signCount >>> 8) & 0xff, signCount & 0xff])
    const parts = [await sha256(concat(utf8(rpId))), new Uint8Array([flags]), counter]
    if (attested) parts.push(new Uint8Array(16), new Uint8Array([this.rawId.length >> 8, this.rawId.length & 0xff]), this.rawId, this.cose)
    return concat(...parts)
  }

  private clientData(type: string, challenge: string, o: CeremonyOverrides): Uint8Array<ArrayBuffer> {
    return concat(utf8(JSON.stringify({ type: o.type ?? type, challenge: o.challenge ?? challenge, origin: o.origin ?? ORIGIN, crossOrigin: o.crossOrigin ?? false })))
  }

  /** Answers `navigator.credentials.create()` with "none" attestation. */
  async register(options: CreationOptions, o: RegisterOverrides = {}): Promise<Record<string, unknown>> {
    this.userHandle = options.user.id
    if (o.signCount !== undefined) this.signCount = o.signCount
    const authData = await this.authData(o.rpId ?? options.rp.id, o.flags ?? UP | UV | AT, this.signCount, true)
    const attestationObject = cbor(new Map<CborValue, CborValue>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    const id = o.id ?? this.id
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, o)),
        attestationObject: b64url(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: { credProps: { rk: true } },
      authenticatorAttachment: 'platform',
    }
  }

  /** Answers `navigator.credentials.get()`; the counter advances unless `signCount` pins it. */
  async assert(options: RequestOptions, o: AssertOverrides = {}): Promise<Record<string, unknown>> {
    this.signCount = o.signCount ?? this.signCount + 1
    const authData = await this.authData(o.rpId ?? options.rpId, o.flags ?? UP | UV, this.signCount, false)
    const clientData = this.clientData('webauthn.get', options.challenge, o)
    const signed = concat(authData, await sha256(clientData))
    const signature = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed)))
    if (o.tamper) signature[signature.length - 1] ^= 0x01
    const userHandle = o.userHandle === undefined ? this.userHandle : o.userHandle
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(userHandle === null ? {} : { userHandle }),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }
}

/** The user handle the server issues: base64url of the UTF-8 user id. */
export const userHandleFor = (userId: string): string => b64url(utf8(userId))
