import type { User } from '../../shared/types'
import { toUser } from '../db/map'
import type { UserRow } from '../db/rows'
import { sendMail } from '../email/outbound'
import { verifyMail } from '../email/templates'
import type { Json } from '../http/body'
import { ApiError, badRequest, conflict, tooMany } from '../http/errors'
import { str } from '../http/validate'
import { putChallenge, takeChallenge } from '../lib/challenges'
import { newToken, sha256Hex } from '../lib/crypto'
import { first } from '../lib/db'
import { hit } from '../lib/throttle'
import { DAY, HOUR, MINUTE } from '../lib/time'
import { requireSessionUser } from './access'
import type { Ctx } from './context'
import { appName, loadInstance, outboundEnabled, type Instance } from './instance-store'
import { getUser } from './users'

const KIND = 'verify-email'
const TTL = DAY

export const verifyUrl = (origin: string, token: string): string => `${origin}/verify-email#token=${token}`

const emailDisabled = () =>
  badRequest('This server cannot send email yet. Ask your server admin to set up email.', 'email_disabled')

/** Shared limits for manual and automatic sends, so changing the address cannot be used to spam an inbox. */
async function deliver(ctx: Ctx, user: UserRow, email: string, inst: Instance): Promise<void> {
  if ((await hit(ctx.env, `verify-email-minute:${user.id}`, MINUTE)) > 1) {
    throw tooMany('We just sent a verification email. Wait a minute before asking for another one.')
  }
  if ((await hit(ctx.env, `verify-email-hour:${user.id}`, HOUR)) > 5) {
    throw tooMany('You asked for several verification emails in the last hour. Try again later.')
  }
  const token = newToken('pbv_')
  await putChallenge(ctx.env, await sha256Hex(token), KIND, user.id, { email }, TTL)
  const mail = verifyMail({ to: email, app: appName(ctx.env, inst), url: verifyUrl(ctx.origin, token) })
  if (!(await sendMail(ctx.env, mail, inst))) throw emailDisabled()
}

export async function requestVerification(ctx: Ctx): Promise<void> {
  const { user } = requireSessionUser(ctx)
  const inst = await loadInstance(ctx.env)
  if (!outboundEnabled(ctx.env, inst)) throw emailDisabled()
  if (!user.email) throw badRequest('Add an email address to your profile first.', 'no_email')
  if (user.email_verified === 1) throw conflict('Your email address is already verified.', 'already_verified')
  try {
    await deliver(ctx, user, user.email, inst)
  } catch (e) {
    if (e instanceof ApiError) throw e
    console.error('verification email failed', e)
    throw new ApiError(502, 'email_failed', 'The email could not be sent. Try again in a few minutes, or ask your server admin to check the email settings.')
  }
}

/** After sign-up or an email change: runs in the background and never fails the request that triggered it. */
export function sendVerificationLater(ctx: Ctx, user: UserRow): void {
  const email = user.email
  if (!email || user.email_verified === 1) return
  const task = async () => {
    const inst = await loadInstance(ctx.env)
    if (outboundEnabled(ctx.env, inst)) await deliver(ctx, user, email, inst)
  }
  ctx.waitUntil(
    task().catch((e: unknown) => {
      if (!(e instanceof ApiError)) console.error('verification email failed', e)
    }),
  )
}

/** Works signed in or out; only a caller signed in as the verified user gets the updated `User` back. */
export async function verifyEmail(ctx: Ctx, body: Json): Promise<{ user?: User }> {
  const token = str(body, 'token', { max: 200 })
  const found = await takeChallenge<{ email: string }>(ctx.env, KIND, await sha256Hex(token))
  const user = found?.userId ? await getUser(ctx.env, found.userId) : null
  const updated =
    found && user?.email === found.data.email
      ? await first<UserRow>(
          ctx.env.DB,
          'UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ? AND email = ? RETURNING *',
          Date.now(),
          user.id,
          found.data.email,
        )
      : null
  if (!updated) throw badRequest('This verification link is invalid, has expired, or was already used.', 'invalid_token')
  return ctx.actor.type === 'user' && ctx.actor.user.id === updated.id ? { user: toUser(updated) } : {}
}
