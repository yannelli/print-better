import type { User, WorkspaceSummary } from '../../shared/types'
import { burnPasswordCheck, hashPassword, verifyPassword } from '../auth/password'
import { createSession, revokeSession, revokeUserSessions } from '../auth/sessions'
import { toUser } from '../db/map'
import type { UserRow } from '../db/rows'
import { sendMail } from '../email/outbound'
import { resetMail } from '../email/templates'
import type { Json } from '../http/body'
import { badRequest, conflict, forbidden, unauthorized } from '../http/errors'
import { EMAIL, NAME, USERNAME, optPassword, optStr, password, str } from '../http/validate'
import { putChallenge, takeChallenge } from '../lib/challenges'
import { newToken, safeEqual, sha256Hex } from '../lib/crypto'
import { first, run } from '../lib/db'
import { assertUnder, hit, limit, reset } from '../lib/throttle'
import { HOUR, MINUTE } from '../lib/time'
import { actingUser, asUser, type Ctx } from './context'
import { appName, loadInstance, outboundEnabled, setupRequired } from './instance-store'
import { joinWithInvite, requireInvite } from './invites'
import { useRecoveryCode } from './recovery'
import { findUserByLogin, getUser, insertUser } from './users'
import { insertWorkspace, userWorkspaces } from './workspaces'
import { audit } from './audit'
import { sendVerificationLater } from './email-verification'
import { requireScope } from './access'

export interface SignIn {
  user: User
  /** `pbs_` value for the session cookie; the HTTP layer sets it. */
  sessionToken: string
}

export async function signIn(ctx: Ctx, user: UserRow): Promise<SignIn> {
  return { user: toUser(user), sessionToken: await createSession(ctx.env, user.id, { ip: ctx.ip, userAgent: ctx.userAgent }) }
}

/** No-op when SETUP_TOKEN is unset; otherwise a constant-time match is required. */
export function checkSetupToken(env: Env, provided: unknown): void {
  if (!env.SETUP_TOKEN) return
  if (typeof provided !== 'string' || !safeEqual(provided, env.SETUP_TOKEN)) throw forbidden('The setup token is not correct', 'bad_setup_token')
}

export async function setup(ctx: Ctx, body: Json): Promise<SignIn> {
  await limit(ctx.env, `setup:${ctx.ip}`, 10, HOUR)
  checkSetupToken(ctx.env, body.setupToken)
  const pw = optPassword(body, 'password')
  const workspaceName = str(body, 'workspaceName', NAME)
  const user = await insertUser(
    ctx.env,
    {
      username: str(body, 'username', USERNAME),
      name: str(body, 'name', NAME),
      email: null,
      emailVerified: false,
      passwordHash: pw ? await hashPassword(ctx.env, pw) : null,
      isAdmin: true,
    },
    true,
  )
  if (!user) throw conflict('Setup is already complete', 'setup_complete')
  const ws = await insertWorkspace(ctx.env, workspaceName, user.id)
  await audit(asUser(ctx, user), ws.id, 'instance.setup', user.id)
  return signIn(ctx, user)
}

/** Open sign-up, or invite-only with a valid `pbi_` token. */
export async function signupAllowed(env: Env, inviteToken: string | undefined) {
  if (await setupRequired(env)) throw conflict('Finish first-run setup first', 'setup_required')
  const invite = inviteToken ? await requireInvite(env, inviteToken) : null
  if (!invite && (await loadInstance(env)).config.signup !== 'open') throw forbidden('Sign-up is by invitation only', 'signup_closed')
  return invite
}

export async function register(ctx: Ctx, body: Json): Promise<SignIn> {
  const invite = await signupAllowed(ctx.env, optStr(body, 'inviteToken', { max: 200 }))
  await limit(ctx.env, `register:${ctx.ip}`, 20, HOUR)
  const pw = password(body, 'password')
  const user = await insertUser(ctx.env, {
    username: str(body, 'username', USERNAME),
    name: str(body, 'name', NAME),
    email: optStr(body, 'email', EMAIL) ?? null,
    emailVerified: false,
    passwordHash: await hashPassword(ctx.env, pw),
    isAdmin: false,
  })
  if (!user) throw new Error('user insert returned no row')
  if (invite) await joinWithInvite(asUser(ctx, user), invite, user.id)
  sendVerificationLater(ctx, user)
  return signIn(ctx, user)
}

export async function login(ctx: Ctx, body: Json): Promise<SignIn> {
  const loginName = str(body, 'login', { max: 254 }).toLowerCase()
  const pw = body.password
  if (typeof pw !== 'string' || pw === '' || pw.length > 256) throw badRequest('password is required')
  const loginKey = `login:${loginName}`
  const ipKey = `login-ip:${ctx.ip ?? 'unknown'}`
  await assertUnder(ctx.env, loginKey, 10)
  await assertUnder(ctx.env, ipKey, 100)
  const user = await findUserByLogin(ctx.env, loginName)
  const result = user?.password_hash ? await verifyPassword(ctx.env, pw, user.password_hash) : null
  if (!user || !result?.ok) {
    if (!result) await burnPasswordCheck(ctx.env, pw)
    await Promise.all([hit(ctx.env, loginKey, 15 * MINUTE), hit(ctx.env, ipKey, 15 * MINUTE)])
    throw unauthorized('Wrong username or password', 'invalid_credentials')
  }
  await reset(ctx.env, loginKey)
  if (result.rehash) await run(ctx.env.DB, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(ctx.env, pw), user.id)
  return signIn(ctx, user)
}

export async function logout(ctx: Ctx): Promise<void> {
  if (ctx.actor.type === 'user') await revokeSession(ctx.env, ctx.actor.sessionId)
}

export async function sessionInfo(ctx: Ctx): Promise<{ user: User | null; workspaces: WorkspaceSummary[] }> {
  requireScope(ctx, 'read')
  const user = actingUser(ctx)
  if (!user) return { user: null, workspaces: [] }
  const pinned = ctx.actor.type === 'token' ? ctx.actor.workspaceId : null
  return { user: toUser(user), workspaces: await userWorkspaces(ctx.env, user.id, pinned) }
}

export async function recover(ctx: Ctx, body: Json): Promise<SignIn> {
  const loginName = str(body, 'login', { max: 254 }).toLowerCase()
  const code = str(body, 'code', { max: 40 })
  const next = optPassword(body, 'newPassword')
  await limit(ctx.env, `recover:${loginName}`, 5, HOUR)
  await limit(ctx.env, `recover-ip:${ctx.ip ?? 'unknown'}`, 20, HOUR)
  const user = await findUserByLogin(ctx.env, loginName)
  if (!user || !(await useRecoveryCode(ctx.env, user.id, code))) throw unauthorized('That recovery code is not valid', 'invalid_credentials')
  if (next) {
    await run(ctx.env.DB, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(ctx.env, next), Date.now(), user.id)
    await revokeUserSessions(ctx.env, user.id)
  }
  await audit(asUser(ctx, user), null, 'user.recover', user.id, { passwordChanged: Boolean(next) })
  return signIn(ctx, (await getUser(ctx.env, user.id)) ?? user)
}

export const resetUrl = (origin: string, token: string): string => `${origin}/reset-password#token=${token}`

/** `verifiesEmail` is set only for emailed links: using one proves the user controls that address. */
export async function issueResetToken(env: Env, userId: string, ttlMs: number, verifiesEmail: string | null): Promise<string> {
  const token = newToken('pbp_')
  await putChallenge(env, await sha256Hex(token), 'reset', userId, { verifiesEmail }, ttlMs)
  return token
}

export async function resetRequest(ctx: Ctx, body: Json): Promise<void> {
  const inst = await loadInstance(ctx.env)
  if (!outboundEnabled(ctx.env, inst)) throw badRequest('Password reset by email is not available on this server', 'email_disabled')
  const email = str(body, 'email', EMAIL).toLowerCase()
  await limit(ctx.env, `reset:${email}`, 3, HOUR)
  await limit(ctx.env, `reset-ip:${ctx.ip ?? 'unknown'}`, 10, HOUR)
  const user = await first<UserRow>(ctx.env.DB, 'SELECT * FROM users WHERE email = ?', email)
  if (!user?.email) return
  const token = await issueResetToken(ctx.env, user.id, HOUR, user.email)
  await sendMail(ctx.env, resetMail({ to: user.email, app: appName(ctx.env, inst), url: resetUrl(ctx.origin, token) }), inst)
}

export async function resetConfirm(ctx: Ctx, body: Json): Promise<SignIn> {
  const token = str(body, 'token', { max: 200 })
  const pw = password(body, 'password')
  const found = await takeChallenge<{ verifiesEmail: string | null }>(ctx.env, 'reset', await sha256Hex(token))
  const user = found?.userId ? await getUser(ctx.env, found.userId) : null
  if (!found || !user) throw badRequest('This reset link is invalid or has expired', 'reset_invalid')
  const verified = found.data.verifiesEmail !== null && found.data.verifiesEmail === user.email
  await run(
    ctx.env.DB,
    'UPDATE users SET password_hash = ?, email_verified = CASE WHEN ? THEN 1 ELSE email_verified END, updated_at = ? WHERE id = ?',
    await hashPassword(ctx.env, pw),
    verified,
    Date.now(),
    user.id,
  )
  await revokeUserSessions(ctx.env, user.id)
  await audit(asUser(ctx, user), null, 'password.reset', user.id)
  return signIn(ctx, (await getUser(ctx.env, user.id)) ?? user)
}
