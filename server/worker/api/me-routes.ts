import { ctxOf } from '../http/authenticate'
import { readJson } from '../http/body'
import { clearSessionCookie } from '../http/cookies'
import type { Router } from '../http/router'
import { requestVerification } from '../services/email-verification'
import { listIdentities, unlinkIdentity } from '../services/identities'
import { changePassword, deletePasskey, deleteSession, getMe, listPasskeys, listSessions, patchMe, renamePasskey } from '../services/me'
import { generateRecoveryCodes } from '../services/recovery'
import { createToken, deleteToken, listTokens } from '../services/tokens'

export function meRoutes(r: Router): void {
  r.get('/api/me', async (h) => getMe(await ctxOf(h)))
  r.patch('/api/me', async (h) => patchMe(await ctxOf(h), await readJson(h.req)))
  r.put('/api/me/password', async (h) => {
    await changePassword(await ctxOf(h), await readJson(h.req))
  })

  r.post('/api/me/email/verification', async (h) => {
    await requestVerification(await ctxOf(h))
  })

  r.get('/api/me/identities', async (h) => listIdentities(await ctxOf(h)))
  r.delete('/api/me/identities/:provider', async (h) => {
    await unlinkIdentity(await ctxOf(h), h.params.provider)
  })

  r.get('/api/me/passkeys', async (h) => listPasskeys(await ctxOf(h)))
  r.patch('/api/me/passkeys/:id', async (h) => renamePasskey(await ctxOf(h), h.params.id, await readJson(h.req)))
  r.delete('/api/me/passkeys/:id', async (h) => {
    await deletePasskey(await ctxOf(h), h.params.id)
  })

  r.get('/api/me/sessions', async (h) => listSessions(await ctxOf(h)))
  r.delete('/api/me/sessions/:id', async (h) => {
    const ctx = await ctxOf(h)
    await deleteSession(ctx, h.params.id)
    if (ctx.actor.type === 'user' && ctx.actor.sessionId === h.params.id) h.cookies.push(clearSessionCookie())
  })

  r.post('/api/me/recovery-codes', async (h) => generateRecoveryCodes(await ctxOf(h)))

  r.get('/api/me/tokens', async (h) => listTokens(await ctxOf(h)))
  r.post('/api/me/tokens', async (h) => createToken(await ctxOf(h), await readJson(h.req)))
  r.delete('/api/me/tokens/:id', async (h) => {
    await deleteToken(await ctxOf(h), h.params.id)
  })
}
