import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PricesUpdate } from '@shared/usage'
import { refreshUsage } from '@/lib/cache'
import { qk } from '@/lib/query'
import { usageApi } from './api'

export const usePrices = (ws: string) => useQuery({ queryKey: qk.prices(ws), queryFn: () => usageApi.prices(ws), staleTime: 5 * 60_000 })

export function useSetPrices(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (update: PricesUpdate) => usageApi.setPrices(ws, update),
    onSuccess: (prices) => {
      qc.setQueryData(qk.prices(ws), prices)
      refreshUsage(qc, ws)
    },
    meta: { success: 'Prices saved' },
  })
}

/** What would happen to the job; the last answer stays on screen while the next one loads. */
export const useJobPreview = (ws: string, request: Record<string, unknown> | null) =>
  useQuery({
    queryKey: qk.jobPreview(ws, request),
    queryFn: () => usageApi.preview(ws, request!),
    enabled: request !== null,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
