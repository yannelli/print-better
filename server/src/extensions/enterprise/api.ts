import type {
  BudgetInput,
  BudgetView,
  CostCenter,
  CostCenterDefaults,
  CostCenterDefaultsUpdate,
  CostCenterInput,
  CostCenterList,
  EnterpriseConfig,
  EnterpriseSettingsUpdate,
  PrinterControls,
  ReportDimension,
  ReportSchedule,
  ReportScheduleInput,
  UsageReport,
} from '@shared/enterprise'
import type { MyUsage } from '@shared/policies'
import type { Job } from '@shared/types'
import { enc, http, qs } from '@/lib/api/http'

const base = (ws: string) => `/workspaces/${enc(ws)}`
const job = (ws: string, id: string, action: string) => `${base(ws)}/jobs/${enc(id)}/${action}`

export interface ReportQuery {
  by: ReportDimension
  from: string
  to: string
}

export const enterpriseApi = {
  config: (ws: string) => http.get<EnterpriseConfig>(`${base(ws)}/enterprise`),
  update: (ws: string, update: EnterpriseSettingsUpdate) => http.patch<EnterpriseConfig>(`${base(ws)}/enterprise`, update),
  setControls: (ws: string, printerId: string, controls: Partial<PrinterControls>) =>
    http.patch<PrinterControls>(`${base(ws)}/printers/${enc(printerId)}/enterprise`, controls),

  approvals: (ws: string) => http.get<Job[]>(`${base(ws)}/approvals`),
  approve: (ws: string, id: string, note?: string) => http.post<Job>(job(ws, id, 'approve'), note ? { note } : {}),
  deny: (ws: string, id: string, reason: string) => http.post<Job>(job(ws, id, 'deny'), { reason }),
  ready: (ws: string, everyone: boolean) => http.get<Job[]>(`${base(ws)}/release${qs({ everyone: everyone || undefined })}`),
  release: (ws: string, id: string) => http.post<Job>(job(ws, id, 'release')),
  releaseAll: (ws: string) => http.post<{ released: Job[] }>(`${base(ws)}/release/all`),

  costCenters: (ws: string) => http.get<CostCenterList>(`${base(ws)}/cost-centers`),
  createCostCenter: (ws: string, input: CostCenterInput) => http.post<CostCenter>(`${base(ws)}/cost-centers`, input),
  updateCostCenter: (ws: string, id: string, input: Partial<CostCenterInput>) => http.patch<CostCenter>(`${base(ws)}/cost-centers/${enc(id)}`, input),
  deleteCostCenter: (ws: string, id: string) => http.del(`${base(ws)}/cost-centers/${enc(id)}`),
  defaults: (ws: string) => http.get<CostCenterDefaults>(`${base(ws)}/cost-centers/defaults`),
  setDefaults: (ws: string, update: CostCenterDefaultsUpdate) => http.put<CostCenterDefaults>(`${base(ws)}/cost-centers/defaults`, update),

  budgets: (ws: string) => http.get<BudgetView[]>(`${base(ws)}/budgets`),
  createBudget: (ws: string, input: BudgetInput) => http.post<BudgetView>(`${base(ws)}/budgets`, input),
  updateBudget: (ws: string, id: string, input: Partial<Omit<BudgetInput, 'costCenterId'>>) => http.patch<BudgetView>(`${base(ws)}/budgets/${enc(id)}`, input),
  deleteBudget: (ws: string, id: string) => http.del(`${base(ws)}/budgets/${enc(id)}`),

  report: (ws: string, q: ReportQuery) => http.get<UsageReport>(`${base(ws)}/reports/usage${qs({ ...q })}`),
  myUsage: (ws: string) => http.get<MyUsage>(`${base(ws)}/usage/me`),
  schedules: (ws: string) => http.get<ReportSchedule[]>(`${base(ws)}/reports/schedules`),
  createSchedule: (ws: string, input: ReportScheduleInput) => http.post<ReportSchedule>(`${base(ws)}/reports/schedules`, input),
  deleteSchedule: (ws: string, id: string) => http.del(`${base(ws)}/reports/schedules/${enc(id)}`),
}

/** Downloads go straight to the browser, which keeps the server's file name. */
export const reportCsvUrl = (ws: string, q: ReportQuery) => `/api${base(ws)}/reports/usage${qs({ ...q, format: 'csv' })}`
export const auditCsvUrl = (ws: string, from: string, to: string) => `/api${base(ws)}/audit/export${qs({ from, to })}`
