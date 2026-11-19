import { keepPreviousData, type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { EnterpriseSettings, EnterpriseSettingsUpdate } from '@shared/enterprise'
import type { Job } from '@shared/types'
import { useExtensionActive } from '@/hooks/extensions'
import { putJob, refreshAccess, refreshUsage } from '@/lib/cache'
import { qk } from '@/lib/query'
import { enterpriseApi, type ReportQuery } from './api'

export const keys = {
  config: (ws: string) => [...qk.enterprise(ws), 'config'] as const,
  holds: qk.holds,
  approvals: (ws: string) => [...qk.holds(ws), 'approvals'] as const,
  ready: (ws: string, everyone: boolean) => [...qk.holds(ws), 'ready', everyone] as const,
  costCenters: (ws: string) => [...qk.enterprise(ws), 'cost-centers'] as const,
  defaults: (ws: string) => [...qk.enterprise(ws), 'defaults'] as const,
  schedules: (ws: string) => [...qk.enterprise(ws), 'schedules'] as const,
  budgets: (ws: string) => [...qk.usage(ws), 'budgets'] as const,
  report: (ws: string, q: ReportQuery) => [...qk.usage(ws), 'report', q] as const,
}

const configQuery = (ws: string, enabled: boolean) => ({ queryKey: keys.config(ws), queryFn: () => enterpriseApi.config(ws), enabled, staleTime: 60_000 })

/** Settings and printer controls; fetched only while the extension is active. */
export function useEnterprise(ws: string) {
  return useQuery(configQuery(ws, useExtensionActive(ws, 'enterprise')))
}

/** The parts that are on, as `enterprise.<part>`, for slot and page visibility. */
export function useEnterpriseFeatures(ws: string, active: boolean): ReadonlySet<string> {
  const settings = useQuery(configQuery(ws, active)).data?.settings
  if (!active || !settings) return new Set()
  return new Set((Object.keys(settings) as (keyof EnterpriseSettings)[]).filter((part) => settings[part].enabled).map((part) => `enterprise.${part}`))
}

export function useUpdateEnterprise(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (update: EnterpriseSettingsUpdate) => enterpriseApi.update(ws, update),
    onSuccess: (config) => {
      qc.setQueryData(keys.config(ws), config)
      refreshAccess(qc, ws)
    },
    meta: { success: 'Settings saved' },
  })
}

export function useSetControls(ws: string, printerId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (controls: { approval?: boolean; secureRelease?: boolean }) => enterpriseApi.setControls(ws, printerId, controls),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.config(ws) }),
    meta: { success: 'Printer saved' },
  })
}

export const useApprovals = (ws: string, enabled = true) =>
  useQuery({ queryKey: keys.approvals(ws), queryFn: () => enterpriseApi.approvals(ws), enabled })

export const useReady = (ws: string, everyone = false, enabled = true) =>
  useQuery({ queryKey: keys.ready(ws, everyone), queryFn: () => enterpriseApi.ready(ws, everyone), enabled })

/** A job changed hands: show it everywhere and refetch the held lists. */
function settled(qc: QueryClient, ws: string, jobs: Job[]) {
  for (const job of jobs) putJob(qc, ws, job)
  qc.invalidateQueries({ queryKey: keys.holds(ws) })
  refreshUsage(qc, ws)
}

export function useHoldAction<V>(ws: string, run: (v: V) => Promise<Job | { released: Job[] }>, success: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: (result) => settled(qc, ws, 'released' in result ? result.released : [result]),
    onError: () => qc.invalidateQueries({ queryKey: keys.holds(ws) }),
    meta: { success },
  })
}

export const useApprove = (ws: string) => useHoldAction(ws, ({ id, note }: { id: string; note?: string }) => enterpriseApi.approve(ws, id, note), 'Approved')
export const useDeny = (ws: string) => useHoldAction(ws, ({ id, reason }: { id: string; reason: string }) => enterpriseApi.deny(ws, id, reason), 'Not approved')
export const useRelease = (ws: string) => useHoldAction(ws, (id: string) => enterpriseApi.release(ws, id), 'Released')
export const useReleaseAll = (ws: string) => useHoldAction(ws, () => enterpriseApi.releaseAll(ws), 'Released')

export const useCostCenters = (ws: string, enabled = true) =>
  useQuery({ queryKey: keys.costCenters(ws), queryFn: () => enterpriseApi.costCenters(ws), enabled, staleTime: 60_000 })

export const useDefaults = (ws: string) => useQuery({ queryKey: keys.defaults(ws), queryFn: () => enterpriseApi.defaults(ws) })

export const useBudgets = (ws: string) => useQuery({ queryKey: keys.budgets(ws), queryFn: () => enterpriseApi.budgets(ws) })

export const useReport = (ws: string, q: ReportQuery, enabled: boolean) =>
  useQuery({ queryKey: keys.report(ws, q), queryFn: () => enterpriseApi.report(ws, q), enabled, placeholderData: keepPreviousData })

/** For the alert banner on Home; shares its cache with the Usage page. */
export const useMyUsage = (ws: string, enabled: boolean) => useQuery({ queryKey: qk.myUsage(ws), queryFn: () => enterpriseApi.myUsage(ws), enabled })

export const useSchedules = (ws: string) => useQuery({ queryKey: keys.schedules(ws), queryFn: () => enterpriseApi.schedules(ws) })

/** Any other change: refetch what Enterprise controls and usage show, like the `access` and `usage` events do. */
export function useEnterpriseMutation<V, R>(ws: string, fn: (v: V) => Promise<R>, success?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.enterprise(ws) })
      refreshUsage(qc, ws)
    },
    meta: success ? { success } : undefined,
  })
}
