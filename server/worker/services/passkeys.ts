import type { Passkey } from '../../shared/types'
import { creationOptions, requestOptions, type CredentialDescriptor } from '../auth/webauthn/options'
import { credentialId, userHandle, verifyAssertion, verifyRegistration, type Expected, type NewCredential } from '../auth/webauthn/verify'
import { toPasskey } from '../db/map'
import type { PasskeyRow, UserRow } from '../db/rows'
import type { Json } from '../http/body'
import { badRequest, conflict, unauthorized } from '../http/errors'
import { NAME, USERNAME, optStr, str } from '../http/validate'
import { putChallenge, takeChallenge } from '../lib/challenges'
import { newId, randomBytes } from '../lib/crypto'
import { all, first, parseJson, run } from '../lib/db'
import { b64url } from '../lib/encoding'
import { MINUTE } from '../lib/time'
import { requireSessionUser } from './access'
import { checkSetupToken, signIn, signupAllowed, type SignIn } from './accounts'
import { audit } from './audit'
import { asUser, type Ctx } from './context'
import { appName, loadInstance, setupRequired } from './instance-store'
import { joinWithInvite } from './invites'
import { findUserByLogin, getUser, insertUser } from './users'
import { insertWorkspace } from './workspaces'

const TTL = 5 * MINUTE

interface Ceremony extends Expected {
  userId?: string
  signup?: { username: string; name: string; inviteToken: string | null; workspaceName: string | null }
}

function ceremony(ctx: Ctx): Ceremony {
  return { challenge: b64url(randomBytes(32)), origin: ctx.origin, rpId: new URL(ctx.origin).hostname }
}

async function begin(ctx: Ctx, kind: string, userId: string | null, c: Ceremony): Promise<string> {
  const challengeId = newId()
  await putChallenge(ctx.env, challengeId, kind, userId, c, TTL)
  return challengeId
}

async function finish(ctx: Ctx, kind: string, body: Json): Promise<{ userId: string | null; data: Ceremony }> {
  const found = await takeChallenge<Ceremony>(ctx.env, kind, str(body, 'challengeId', { max: 64 }))
  if (!found) throw badRequest('This passkey request expired. Try again.', 'challenge_expired')
  return found
}

const descriptor = (p: Pick<PasskeyRow, 'id' | 'transports'>): CredentialDescriptor => ({
  type: 'public-key',
  id: p.id,
  transports: parseJson<string[]>(p.transports, []),
})

async function insertPasskey(env: Env, userId: string, cred: NewCredential, name: string): Promise<PasskeyRow> {
  try {
    const row = await first<PasskeyRow>(
      env.DB,
      `INSERT INTO passkeys (id, user_id, public_key, alg, sign_count, transports, backed_up, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      cred.id,
      userId,
      cred.publicKey,
      cred.alg,
      cred.signCount,
      JSON.stringify(cred.transports),
      cred.backedUp,
      name,
      Date.now(),
    )
    if (!row) throw new Error('passkey insert returned no row')
    return row
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('This passkey is already registered', 'passkey_exists')
    throw e
  }
}

export async function registerOptions(ctx: Ctx) {
  const { user } = requireSessionUser(ctx)
  const existing = await all<PasskeyRow>(ctx.env.DB, 'SELECT id, transports FROM passkeys WHERE user_id = ?', user.id)
  const c = ceremony(ctx)
  const options = creationOptions({
    ...c,
    rpName: appName(ctx.env, await loadInstance(ctx.env)),
    userId: user.id,
    userName: user.username,
    displayName: user.name,
    exclude: existing.map(descriptor),
  })
  return { challengeId: await begin(ctx, 'webauthn.register', user.id, c), options }
}

export async function registerVerify(ctx: Ctx, body: Json): Promise<Passkey> {
  const { user } = requireSessionUser(ctx)
  const found = await finish(ctx, 'webauthn.register', body)
  if (found.userId !== user.id) throw badRequest('This passkey request belongs to another account', 'challenge_expired')
  const cred = await verifyRegistration(body.credential, found.data)
  const row = await insertPasskey(ctx.env, user.id, cred, optStr(body, 'name', NAME) ?? 'Passkey')
  await audit(ctx, null, 'passkey.add', user.id, { passkeyId: row.id })
  return toPasskey(row)
}

/** Passwordless account creation; doubles as first-run setup when `setupToken` + `workspaceName` are given. */
export async function signupOptions(ctx: Ctx, body: Json) {
  const username = str(body, 'username', USERNAME)
  const name = str(body, 'name', NAME)
  const inviteToken = optStr(body, 'inviteToken', { max: 200 }) ?? null
  let workspaceName: string | null = null
  if (await setupRequired(ctx.env)) {
    checkSetupToken(ctx.env, body.setupToken)
    workspaceName = str(body, 'workspaceName', NAME)
  } else await signupAllowed(ctx.env, inviteToken ?? undefined)
  if (await findUserByLogin(ctx.env, username)) throw conflict('That username is taken', 'username_taken')
  const c: Ceremony = { ...ceremony(ctx), userId: newId(), signup: { username, name, inviteToken, workspaceName } }
  const options = creationOptions({
    ...c,
    rpName: appName(ctx.env, await loadInstance(ctx.env)),
    userId: c.userId as string,
    userName: username,
    displayName: name,
    exclude: [],
  })
  return { challengeId: await begin(ctx, 'webauthn.signup', null, c), options }
}

export async function signupVerify(ctx: Ctx, body: Json): Promise<SignIn> {
  const { data } = await finish(ctx, 'webauthn.signup', body)
  if (!data.signup || !data.userId) throw badRequest('This passkey request expired. Try again.', 'challenge_expired')
  const cred = await verifyRegistration(body.credential, data)
  const { username, name, inviteToken, workspaceName } = data.signup
  const setup = workspaceName !== null
  const invite = setup ? null : await signupAllowed(ctx.env, inviteToken ?? undefined)
  const user = await insertUser(
    ctx.env,
    { id: data.userId, username, name, email: null, emailVerified: false, passwordHash: null, isAdmin: setup },
    setup,
  )
  if (!user) throw conflict('Setup is already complete', 'setup_complete')
  await insertPasskey(ctx.env, user.id, cred, 'Passkey')
  const actor = asUser(ctx, user)
  if (setup) {
    const ws = await insertWorkspace(ctx.env, workspaceName, user.id)
    await audit(actor, ws.id, 'instance.setup', user.id)
  } else if (invite) await joinWithInvite(actor, invite, user.id)
  return signIn(ctx, user)
}

/** With `login`, offers that account's passkeys; without, an empty list enables discoverable/autofill sign-in. */
export async function loginOptions(ctx: Ctx, body: Json) {
  const login = optStr(body, 'login', { max: 254 })?.toLowerCase()
  const user = login ? await findUserByLogin(ctx.env, login) : null
  const allow = user ? await all<PasskeyRow>(ctx.env.DB, 'SELECT id, transports FROM passkeys WHERE user_id = ?', user.id) : []
  const c = ceremony(ctx)
  return { challengeId: await begin(ctx, 'webauthn.login', null, c), options: requestOptions({ ...c, allow: allow.map(descriptor) }) }
}

export async function loginVerify(ctx: Ctx, body: Json): Promise<SignIn> {
  const { data } = await finish(ctx, 'webauthn.login', body)
  const passkey = await first<PasskeyRow>(ctx.env.DB, 'SELECT * FROM passkeys WHERE id = ?', credentialId(body.credential))
  if (!passkey) throw unauthorized('This passkey is not registered here', 'passkey_unknown')
  const handle = userHandle(body.credential)
  if (handle !== null && handle !== passkey.user_id) throw unauthorized('This passkey belongs to a different account', 'passkey_invalid')
  const result = await verifyAssertion(body.credential, data, { publicKey: passkey.public_key, alg: passkey.alg, signCount: passkey.sign_count })
  if (result.cloned) console.warn('passkey sign counter did not increase', passkey.id)
  await run(
    ctx.env.DB,
    'UPDATE passkeys SET sign_count = ?, backed_up = ?, last_used_at = ? WHERE id = ?',
    result.signCount,
    result.backedUp,
    Date.now(),
    passkey.id,
  )
  const user = (await getUser(ctx.env, passkey.user_id)) as UserRow
  return signIn(ctx, user)
}
