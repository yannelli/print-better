import { scrypt } from 'node:crypto'
import { hmacSha256, randomBytes, safeEqual } from '../lib/crypto'
import { b64, fromB64 } from '../lib/encoding'

// OWASP scrypt tier N=2^15 r=8 p=3 (32 MiB) fits the 128 MiB isolate; Node's default maxmem is too small for it.
const CURRENT = { ln: 15, r: 8, p: 3 }
const KEY_LEN = 32
const MAX_MEM = 64 * 1024 * 1024

type Params = typeof CURRENT

function derive(input: Uint8Array, salt: Uint8Array, { ln, r, p }: Params): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    scrypt(input, salt, KEY_LEN, { N: 2 ** ln, r, p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(new Uint8Array(key)))),
  )
}

/** The pepper lives outside the database, so a leaked users table alone cannot be cracked. */
function pepper(env: Env, password: string): Promise<Uint8Array> {
  if (!env.AUTH_PEPPER) throw new Error('AUTH_PEPPER is not configured')
  return hmacSha256(env.AUTH_PEPPER, password)
}

/** Self-describing: `$scrypt$ln=15,r=8,p=3$<salt>$<hash>` over HMAC-SHA256(AUTH_PEPPER, password). */
export async function hashPassword(env: Env, password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(await pepper(env, password), salt, CURRENT)
  return `$scrypt$ln=${CURRENT.ln},r=${CURRENT.r},p=${CURRENT.p}$${b64(salt)}$${b64(key)}`
}

function parse(stored: string): { params: Params; salt: Uint8Array; key: Uint8Array } | null {
  const m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored)
  if (!m) return null
  return { params: { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) }, salt: fromB64(m[4]), key: fromB64(m[5]) }
}

/** `rehash` is true when the stored hash uses older parameters and should be upgraded. */
export async function verifyPassword(env: Env, password: string, stored: string): Promise<{ ok: boolean; rehash: boolean }> {
  const parsed = parse(stored)
  if (!parsed) return { ok: false, rehash: false }
  const key = await derive(await pepper(env, password), parsed.salt, parsed.params)
  const ok = safeEqual(key, parsed.key)
  const { ln, r, p } = parsed.params
  return { ok, rehash: ok && (ln !== CURRENT.ln || r !== CURRENT.r || p !== CURRENT.p) }
}

let dummy: string | null = null

/** Spends the same work as a real check so unknown usernames are not revealed by timing. */
export async function burnPasswordCheck(env: Env, password: string): Promise<void> {
  dummy ??= await hashPassword(env, 'print-better-timing-equalizer')
  await verifyPassword(env, password, dummy)
}
