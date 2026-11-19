import { ctxOf } from '../../http/authenticate'
import { readJson } from '../../http/body'
import type { Router } from '../../http/router'
import { cycleUsage, myUsage } from './limit-views'
import { addAdjustment, createLimit, deleteLimit, listAdjustments, listLimits, updateLimit } from './limits'
import { createRule, deleteRule, listRules, reorderRules, updateRule } from './rules'

const WS = '/api/workspaces/:ws'

/** docs/print-policies.md. Every route answers 404 extension_inactive while the extension is off. */
export function printPolicyRoutes(r: Router): void {
  r.get(`${WS}/policies/rules`, async (h) => listRules(await ctxOf(h), h.params.ws))
  r.post(`${WS}/policies/rules`, async (h) => createRule(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.put(`${WS}/policies/rules/order`, async (h) => reorderRules(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.patch(`${WS}/policies/rules/:id`, async (h) => updateRule(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.delete(`${WS}/policies/rules/:id`, async (h) => {
    await deleteRule(await ctxOf(h), h.params.ws, h.params.id)
  })

  r.get(`${WS}/policies/limits`, async (h) => listLimits(await ctxOf(h), h.params.ws))
  r.post(`${WS}/policies/limits`, async (h) => createLimit(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.patch(`${WS}/policies/limits/:id`, async (h) => updateLimit(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.delete(`${WS}/policies/limits/:id`, async (h) => {
    await deleteLimit(await ctxOf(h), h.params.ws, h.params.id)
  })
  r.get(`${WS}/policies/limits/:id/adjustments`, async (h) => listAdjustments(await ctxOf(h), h.params.ws, h.params.id))
  r.post(`${WS}/policies/limits/:id/adjustments`, async (h) => addAdjustment(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))

  r.get(`${WS}/usage/me`, async (h) => myUsage(await ctxOf(h), h.params.ws))
  r.get(`${WS}/usage`, async (h) => cycleUsage(await ctxOf(h), h.params.ws, h.url.searchParams.get('cycle')))
}
