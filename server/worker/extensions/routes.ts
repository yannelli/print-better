import { ctxOf } from '../http/authenticate'
import { readJson } from '../http/body'
import type { Router } from '../http/router'
import { enterpriseRoutes } from './enterprise/routes'
import { printPolicyRoutes } from './print-policies/routes'
import { printerAccessRoutes } from './printer-access/routes'
import { listInstanceExtensions, listWorkspaceExtensions, patchInstanceExtension, patchWorkspaceExtension } from './service'
import { usageRoutes } from './usage/routes'

/** The two switches (docs/extensions.md), then each extension's own routes. */
export function extensionRoutes(r: Router): void {
  r.get('/api/admin/extensions', async (h) => listInstanceExtensions(await ctxOf(h)))
  r.patch('/api/admin/extensions/:id', async (h) => patchInstanceExtension(await ctxOf(h), h.params.id, await readJson(h.req)))
  r.get('/api/workspaces/:ws/extensions', async (h) => listWorkspaceExtensions(await ctxOf(h), h.params.ws))
  r.patch('/api/workspaces/:ws/extensions/:id', async (h) => patchWorkspaceExtension(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  printerAccessRoutes(r)
  usageRoutes(r)
  printPolicyRoutes(r)
  enterpriseRoutes(r)
}
