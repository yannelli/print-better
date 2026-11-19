import { hmacSha256, randomString } from '../lib/crypto'
import { stmt, run } from '../lib/db'
import { hex } from '../lib/encoding'
import { requireSessionUser } from './access'
import { audit } from './audit'
import type { Ctx } from './context'

// No 0/1/i/l/o, so codes survive being read aloud or written down; 12 chars is about 59 bits.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const COUNT = 10

const normalize = (code: string): string => code.toLowerCase().replace(/[^a-z0-9]/g, '')

async function codeHash(env: Env, code: string): Promise<string> {
  if (!env.AUTH_PEPPER) throw new Error('AUTH_PEPPER is not configured')
  return hex(await hmacSha256(env.AUTH_PEPPER, `recovery:${normalize(code)}`))
}

/** Replaces all of the user's codes; the plaintext is returned once and never stored. */
export async function generateRecoveryCodes(ctx: Ctx): Promise<{ codes: string[] }> {
  const { user } = requireSessionUser(ctx)
  const codes = Array.from({ length: COUNT }, () => {
    const raw = randomString(ALPHABET, 12)
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`
  })
  const hashes = await Promise.all(codes.map((c) => codeHash(ctx.env, c)))
  await ctx.env.DB.batch([
    stmt(ctx.env.DB, 'DELETE FROM recovery_codes WHERE user_id = ?', user.id),
    ...hashes.map((h) => stmt(ctx.env.DB, 'INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)', user.id, h)),
  ])
  await audit(ctx, null, 'recovery.create', user.id)
  return { codes }
}

/** Marks a matching unused code as used; false when it does not exist or was already spent. */
export async function useRecoveryCode(env: Env, userId: string, code: string): Promise<boolean> {
  const changed = await run(
    env.DB,
    'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    Date.now(),
    userId,
    await codeHash(env, code),
  )
  return changed === 1
}
