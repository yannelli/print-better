import { hmacSha256, safeEqual } from '../lib/crypto'
import { b64, fromB64 } from '../lib/encoding'

const TOLERANCE_S = 300

/** Svix (Resend) webhook signature: HMAC-SHA256 over `id.timestamp.rawBody` with the base64 `whsec_` key. */
export async function verifySvix(secret: string, headers: Headers, rawBody: string, nowMs = Date.now()): Promise<boolean> {
  const id = headers.get('svix-id')
  const timestamp = headers.get('svix-timestamp')
  const signatures = headers.get('svix-signature')
  if (!id || !timestamp || !signatures) return false
  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt) || Math.abs(nowMs / 1000 - sentAt) > TOLERANCE_S) return false
  let key: Uint8Array
  try {
    key = fromB64(secret.startsWith('whsec_') ? secret.slice(6) : secret)
  } catch {
    return false
  }
  const expected = b64(await hmacSha256(key, `${id}.${timestamp}.${rawBody}`))
  return signatures.split(' ').some((entry) => {
    const [version, signature] = entry.split(',')
    return version === 'v1' && signature !== undefined && safeEqual(signature, expected)
  })
}
