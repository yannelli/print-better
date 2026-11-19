import type {
  LimitAdjustment,
  LimitAdjustmentInput,
  MyUsage,
  PrintLimit,
  PrintLimitInput,
  PrintLimitView,
  PrintRule,
  PrintRuleInput,
} from '@shared/policies'
import { enc, http } from '@/lib/api/http'

const rules = (ws: string, path = '') => `/workspaces/${enc(ws)}/policies/rules${path}`
const limits = (ws: string, path = '') => `/workspaces/${enc(ws)}/policies/limits${path}`

export const policiesApi = {
  rules: (ws: string) => http.get<PrintRule[]>(rules(ws)),
  createRule: (ws: string, input: PrintRuleInput) => http.post<PrintRule>(rules(ws), input),
  updateRule: (ws: string, id: string, input: Partial<PrintRuleInput>) => http.patch<PrintRule>(rules(ws, `/${enc(id)}`), input),
  deleteRule: (ws: string, id: string) => http.del(rules(ws, `/${enc(id)}`)),
  reorderRules: (ws: string, ids: string[]) => http.put<PrintRule[]>(rules(ws, '/order'), { ids }),

  limits: (ws: string) => http.get<PrintLimitView[]>(limits(ws)),
  createLimit: (ws: string, input: PrintLimitInput) => http.post<PrintLimit>(limits(ws), input),
  updateLimit: (ws: string, id: string, input: Partial<PrintLimitInput>) => http.patch<PrintLimit>(limits(ws, `/${enc(id)}`), input),
  deleteLimit: (ws: string, id: string) => http.del(limits(ws, `/${enc(id)}`)),
  allowances: (ws: string, id: string) => http.get<LimitAdjustment[]>(limits(ws, `/${enc(id)}/adjustments`)),
  addAllowance: (ws: string, id: string, input: LimitAdjustmentInput) => http.post<LimitAdjustment>(limits(ws, `/${enc(id)}/adjustments`), input),

  mine: (ws: string) => http.get<MyUsage>(`/workspaces/${enc(ws)}/usage/me`),
  cycle: (ws: string, cycle: 'current' | 'previous') => http.get<PrintLimitView[]>(`/workspaces/${enc(ws)}/usage?cycle=${cycle}`),
}
