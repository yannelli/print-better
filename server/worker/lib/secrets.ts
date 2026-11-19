import { randomBytes } from './crypto'
import { b64url, fromB64url, fromUtf8, utf8 } from './encoding'

// Resolved keys only: a pending promise shared across requests can hang in workerd.
let cached: { secret: string; key: CryptoKey } | null = null

async function settingsKey(env: Env): Promise<CryptoKey> {
  const secret = env.APP_SECRET
  if (!secret) throw new Error('APP_SECRET is not configured')
  if (cached?.secret === secret) return cached.key
  const base = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8('print-better'), info: utf8('instance-settings-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  cached = { secret, key }
  return key
}

/** AES-GCM with the slot name as associated data, so a ciphertext cannot be moved to another setting. */
export async function encryptSecret(env: Env, slot: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(slot) }, await settingsKey(env), utf8(plaintext))
  return `v1.${b64url(iv)}.${b64url(ct)}`
}

export async function decryptSecret(env: Env, slot: string, stored: string): Promise<string> {
  const [version, iv, ct] = stored.split('.')
  if (version !== 'v1' || !iv || !ct) throw new Error(`unsupported secret format for ${slot}`)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64url(iv), additionalData: utf8(slot) },
    await settingsKey(env),
    fromB64url(ct),
  )
  return fromUtf8(pt)
}
