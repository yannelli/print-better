const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => encoder.encode(s) as Uint8Array<ArrayBuffer>
export const fromUtf8 = (b: ArrayBuffer | Uint8Array): string => decoder.decode(b)

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

export function b64(data: ArrayBuffer | Uint8Array): string {
  let s = ''
  for (const byte of toBytes(data)) s += String.fromCharCode(byte)
  return btoa(s)
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const b64url = (data: ArrayBuffer | Uint8Array): string =>
  b64(data).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url')
  const padded = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4)
  return fromB64(padded)
}

export function hex(data: ArrayBuffer | Uint8Array): string {
  let s = ''
  for (const byte of toBytes(data)) s += byte.toString(16).padStart(2, '0')
  return s
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, unpadded: alphanumeric ids and tokens that survive copy/paste and shells. */
export function base32(data: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}
