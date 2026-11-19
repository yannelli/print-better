import { resendWebhook } from '../email/resend'
import { ctxOf } from '../http/authenticate'
import { readJson } from '../http/body'
import type { Router } from '../http/router'
import { adminResetLink, deleteUser, listUsers, patchUser } from '../services/admin'
import { getInstanceSettings, patchInstanceSettings } from '../services/instance'

export function adminRoutes(r: Router): void {
  r.get('/api/admin/settings', async (h) => getInstanceSettings(await ctxOf(h)))
  r.patch('/api/admin/settings', async (h) => patchInstanceSettings(await ctxOf(h), await readJson(h.req)))
  r.get('/api/admin/users', async (h) => listUsers(await ctxOf(h)))
  r.patch('/api/admin/users/:id', async (h) => patchUser(await ctxOf(h), h.params.id, await readJson(h.req)))
  r.delete('/api/admin/users/:id', async (h) => {
    await deleteUser(await ctxOf(h), h.params.id)
  })
  r.post('/api/admin/users/:id/reset-password', async (h) => adminResetLink(await ctxOf(h), h.params.id))
}

export function hookRoutes(r: Router): void {
  r.post('/api/hooks/resend', (h) => resendWebhook(h.env, h.req, (p) => h.exec.waitUntil(p)))
}
