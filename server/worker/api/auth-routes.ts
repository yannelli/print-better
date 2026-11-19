import { SESSION_TTL } from '../auth/sessions'
import { ctxOf, publicCtx } from '../http/authenticate'
import { readJson } from '../http/body'
import { clearSessionCookie, readCookie, sessionCookie, SSO_COOKIE, ssoCookie } from '../http/cookies'
import { ApiError } from '../http/errors'
import type { Router } from '../http/router'
import { login, logout, recover, register, resetConfirm, resetRequest, sessionInfo, setup } from '../services/accounts'
import { verifyEmail } from '../services/email-verification'
import { linkIdentity } from '../services/identities'
import { instanceInfo } from '../services/instance'
import { loginOptions, loginVerify, registerOptions, registerVerify, signupOptions, signupVerify } from '../services/passkeys'
import { safeNext, SSO_TTL, ssoSignIn, ssoStart, takeSsoState, type SsoState } from '../services/sso'
import { redirect, withSession } from './respond'

/** SSO runs as full-page navigations, so failures become a redirect to a page that can display them. */
function ssoError(e: unknown, path = '/login'): Response {
  if (!(e instanceof ApiError)) console.error('sso failed', e)
  const url = new URL(path, 'https://app.invalid')
  url.searchParams.set('error', e instanceof ApiError ? e.code : 'sso_failed')
  url.searchParams.set('message', e instanceof ApiError ? e.message : 'Sign-in failed')
  return redirect(`${url.pathname}${url.search}${url.hash}`)
}

const LINK_NEXT = '/account/security'

export function authRoutes(r: Router): void {
  r.get('/api/instance', (h) => instanceInfo(h.env))
  r.get('/api/auth/session', async (h) => sessionInfo(await ctxOf(h)))
  r.post('/api/auth/setup', async (h) => withSession(h, await setup(publicCtx(h), await readJson(h.req))))
  r.post('/api/auth/register', async (h) => withSession(h, await register(publicCtx(h), await readJson(h.req))))
  r.post('/api/auth/login', async (h) => withSession(h, await login(publicCtx(h), await readJson(h.req))))
  r.post('/api/auth/logout', async (h) => {
    await logout(await ctxOf(h))
    h.cookies.push(clearSessionCookie())
  })

  r.post('/api/auth/passkey/register/options', async (h) => registerOptions(await ctxOf(h)))
  r.post('/api/auth/passkey/register/verify', async (h) => registerVerify(await ctxOf(h), await readJson(h.req)))
  r.post('/api/auth/passkey/signup/options', async (h) => signupOptions(publicCtx(h), await readJson(h.req)))
  r.post('/api/auth/passkey/signup/verify', async (h) => withSession(h, await signupVerify(publicCtx(h), await readJson(h.req))))
  r.post('/api/auth/passkey/login/options', async (h) => loginOptions(publicCtx(h), await readJson(h.req)))
  r.post('/api/auth/passkey/login/verify', async (h) => withSession(h, await loginVerify(publicCtx(h), await readJson(h.req))))

  r.get('/api/auth/sso/:provider/start', async (h) => {
    const q = h.url.searchParams
    const link = q.get('link') === '1'
    const next = link ? (q.get('next') ?? LINK_NEXT) : q.get('next')
    try {
      const ctx = link ? await ctxOf(h) : publicCtx(h)
      const { url, state } = await ssoStart(ctx, h.params.provider, { next, invite: q.get('invite'), link })
      h.cookies.push(ssoCookie(state, SSO_TTL))
      return redirect(url)
    } catch (e) {
      return ssoError(e, link ? safeNext(next) : undefined)
    }
  })
  r.get('/api/auth/sso/:provider/callback', async (h) => {
    h.cookies.push(ssoCookie('', 0))
    const params = h.url.searchParams
    let state: SsoState
    try {
      state = await takeSsoState(publicCtx(h), h.params.provider, params, readCookie(h.req, SSO_COOKIE))
    } catch (e) {
      return ssoError(e)
    }
    try {
      if (state.linkUserId) await linkIdentity(await ctxOf(h), state, params)
      else h.cookies.push(sessionCookie(await ssoSignIn(publicCtx(h), state, params), SESSION_TTL))
      return redirect(state.next)
    } catch (e) {
      return ssoError(e, state.linkUserId ? state.next : undefined)
    }
  })

  r.post('/api/auth/verify-email', async (h) => verifyEmail(await ctxOf(h), await readJson(h.req)))
  r.post('/api/auth/recover', async (h) => withSession(h, await recover(publicCtx(h), await readJson(h.req))))
  r.post('/api/auth/reset/request', async (h) => {
    await resetRequest(publicCtx(h), await readJson(h.req))
  })
  r.post('/api/auth/reset/confirm', async (h) => withSession(h, await resetConfirm(publicCtx(h), await readJson(h.req))))
}
