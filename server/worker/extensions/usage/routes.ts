import { ctxOf } from '../../http/authenticate'
import { readJson } from '../../http/body'
import type { Router } from '../../http/router'
import { getPrices, setPrices } from './prices'
import { previewJob } from './preview'

const WS = '/api/workspaces/:ws'

/** docs/usage.md: shared by Print rules and limits and Enterprise controls; 404 extension_inactive while both are off. */
export function usageRoutes(r: Router): void {
  r.post(`${WS}/jobs/preview`, async (h) => previewJob(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.get(`${WS}/prices`, async (h) => getPrices(await ctxOf(h), h.params.ws))
  r.put(`${WS}/prices`, async (h) => setPrices(await ctxOf(h), h.params.ws, await readJson(h.req)))
}
