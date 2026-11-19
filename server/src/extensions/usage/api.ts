import type { JobPreview, Prices, PricesUpdate } from '@shared/usage'
import { enc, http } from '@/lib/api/http'

const base = (ws: string) => `/workspaces/${enc(ws)}`

export const usageApi = {
  prices: (ws: string) => http.get<Prices>(`${base(ws)}/prices`),
  setPrices: (ws: string, update: PricesUpdate) => http.put<Prices>(`${base(ws)}/prices`, update),
  preview: (ws: string, request: Record<string, unknown>) => http.post<JobPreview>(`${base(ws)}/jobs/preview`, request),
}
