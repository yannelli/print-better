import { base32, hex, utf8 } from './encoding'

export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n))

/** 128-bit random id, lowercase base32 (26 chars). */
export const newId = (): string => base32(randomBytes(16))

export type TokenPrefix = 'pbs_' | 'pbc_' | 'pbe_' | 'pbi_' | 'pbt_' | 'pbo_' | 'pbr_' | 'pbp_' | 'pbv_' | 'pbd_'

/** 192-bit bearer secret with a type prefix; only its SHA-256 is stored. */
export const newToken = (prefix: TokenPrefix): string => prefix + base32(randomBytes(24))

const asBytes = (data: string | Uint8Array): Uint8Array => (typeof data === 'string' ? utf8(data) : data)

export async function sha256(data: string | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', asBytes(data)))
}

export const sha256Hex = async (data: string | Uint8Array): Promise<string> => hex(await sha256(data))

export async function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', asBytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, asBytes(data)))
}

/** Constant-time comparison; only the length difference is observable. */
export function safeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = asBytes(a)
  const y = asBytes(b)
  if (x.length !== y.length) return false
  return crypto.subtle.timingSafeEqual(x, y)
}

/** Uniform random string over an arbitrary alphabet (rejection sampling avoids modulo bias). */
export function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length]
    }
  }
  return out
}
