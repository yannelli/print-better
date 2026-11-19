import { ctxOf } from '../../http/authenticate'
import { readJson } from '../../http/body'
import type { Router } from '../../http/router'
import { approveJob, denyJob, listApprovals } from './approvals'
import { createBudget, deleteBudget, listBudgets, updateBudget } from './budgets'
import { createCostCenter, deleteCostCenter, listCostCenters, updateCostCenter } from './cost-centers'
import { getDefaults, putDefaults } from './defaults'
import { exportAudit, getUsageReport } from './exports'
import { listRelease, releaseAll, releaseJob } from './release'
import { createSchedule, deleteSchedule, listSchedules } from './schedules'
import { getEnterprise, patchEnterprise, setPrinterControls } from './settings'

const WS = '/api/workspaces/:ws'

/** docs/enterprise.md. Every route answers 404 extension_inactive while it is off, and 409 part_off while its part is. */
export function enterpriseRoutes(r: Router): void {
  r.get(`${WS}/enterprise`, async (h) => getEnterprise(await ctxOf(h), h.params.ws))
  r.patch(`${WS}/enterprise`, async (h) => patchEnterprise(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.patch(`${WS}/printers/:id/enterprise`, async (h) => setPrinterControls(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))

  r.get(`${WS}/approvals`, async (h) => listApprovals(await ctxOf(h), h.params.ws))
  r.post(`${WS}/jobs/:id/approve`, async (h) => approveJob(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.post(`${WS}/jobs/:id/deny`, async (h) => denyJob(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.get(`${WS}/release`, async (h) => listRelease(await ctxOf(h), h.params.ws, h.url.searchParams.get('everyone') === 'true'))
  r.post(`${WS}/release/all`, async (h) => releaseAll(await ctxOf(h), h.params.ws))
  r.post(`${WS}/jobs/:id/release`, async (h) => releaseJob(await ctxOf(h), h.params.ws, h.params.id))

  r.get(`${WS}/cost-centers/defaults`, async (h) => getDefaults(await ctxOf(h), h.params.ws))
  r.put(`${WS}/cost-centers/defaults`, async (h) => putDefaults(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.get(`${WS}/cost-centers`, async (h) => listCostCenters(await ctxOf(h), h.params.ws))
  r.post(`${WS}/cost-centers`, async (h) => createCostCenter(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.patch(`${WS}/cost-centers/:id`, async (h) => updateCostCenter(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.delete(`${WS}/cost-centers/:id`, async (h) => {
    await deleteCostCenter(await ctxOf(h), h.params.ws, h.params.id)
  })

  r.get(`${WS}/budgets`, async (h) => listBudgets(await ctxOf(h), h.params.ws))
  r.post(`${WS}/budgets`, async (h) => createBudget(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.patch(`${WS}/budgets/:id`, async (h) => updateBudget(await ctxOf(h), h.params.ws, h.params.id, await readJson(h.req)))
  r.delete(`${WS}/budgets/:id`, async (h) => {
    await deleteBudget(await ctxOf(h), h.params.ws, h.params.id)
  })

  r.get(`${WS}/reports/usage`, async (h) => {
    const q = h.url.searchParams
    return getUsageReport(await ctxOf(h), h.params.ws, { by: q.get('by'), from: q.get('from'), to: q.get('to'), format: q.get('format') })
  })
  r.get(`${WS}/reports/schedules`, async (h) => listSchedules(await ctxOf(h), h.params.ws))
  r.post(`${WS}/reports/schedules`, async (h) => createSchedule(await ctxOf(h), h.params.ws, await readJson(h.req)))
  r.delete(`${WS}/reports/schedules/:id`, async (h) => {
    await deleteSchedule(await ctxOf(h), h.params.ws, h.params.id)
  })
  r.get(`${WS}/audit/export`, async (h) => exportAudit(await ctxOf(h), h.params.ws, { from: h.url.searchParams.get('from'), to: h.url.searchParams.get('to') }))
}
