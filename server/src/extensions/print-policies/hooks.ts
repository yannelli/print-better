import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LimitAdjustmentInput, PrintLimitInput, PrintRule, PrintRuleInput } from '@shared/policies'
import { useClients } from '@/hooks/devices'
import { useExtensionActive } from '@/hooks/extensions'
import { useMembers } from '@/hooks/members'
import { useAddedPrinters } from '@/hooks/printers'
import { accessApi } from '@/extensions/printer-access/api'
import { refreshUsage } from '@/lib/cache'
import { qk } from '@/lib/query'
import { policiesApi } from './api'

export const useRules = (ws: string) => useQuery({ queryKey: qk.rules(ws), queryFn: () => policiesApi.rules(ws) })
export const useLimits = (ws: string) => useQuery({ queryKey: qk.limits(ws), queryFn: () => policiesApi.limits(ws) })
export const useMyUsage = (ws: string) => useQuery({ queryKey: qk.myUsage(ws), queryFn: () => policiesApi.mine(ws) })
export const useCycleUsage = (ws: string, cycle: 'current' | 'previous') =>
  useQuery({ queryKey: qk.cycleUsage(ws, cycle), queryFn: () => policiesApi.cycle(ws, cycle) })
export const useAllowances = (ws: string, limitId: string) =>
  useQuery({ queryKey: qk.allowances(ws, limitId), queryFn: () => policiesApi.allowances(ws, limitId) })

/** Any change to rules or limits: refetch everything usage shows, like the `usage` event does. */
function useUsageMutation<V, R>(ws: string, fn: (v: V) => Promise<R>, success: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => refreshUsage(qc, ws), meta: { success } })
}

export const useCreateRule = (ws: string) => useUsageMutation(ws, (input: PrintRuleInput) => policiesApi.createRule(ws, input), 'Rule added')
export const useUpdateRule = (ws: string) =>
  useUsageMutation(ws, ({ id, input }: { id: string; input: Partial<PrintRuleInput> }) => policiesApi.updateRule(ws, id, input), 'Rule saved')
export const useDeleteRule = (ws: string) => useUsageMutation(ws, (id: string) => policiesApi.deleteRule(ws, id), 'Rule deleted')

/** Moves rules at once on screen, then saves the order. */
export function useReorderRules(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (rules: PrintRule[]) => policiesApi.reorderRules(ws, rules.map((r) => r.id)),
    onMutate: (rules) => qc.setQueryData(qk.rules(ws), rules),
    onSettled: () => refreshUsage(qc, ws),
  })
}

export const useCreateLimit = (ws: string) => useUsageMutation(ws, (input: PrintLimitInput) => policiesApi.createLimit(ws, input), 'Limit added')
export const useUpdateLimit = (ws: string) =>
  useUsageMutation(ws, ({ id, input }: { id: string; input: Partial<PrintLimitInput> }) => policiesApi.updateLimit(ws, id, input), 'Limit saved')
export const useDeleteLimit = (ws: string) => useUsageMutation(ws, (id: string) => policiesApi.deleteLimit(ws, id), 'Limit deleted')
export const useAddAllowance = (ws: string) =>
  useUsageMutation(ws, ({ id, input }: { id: string; input: LimitAdjustmentInput }) => policiesApi.addAllowance(ws, id, input), 'Extra allowance added')

/** Groups belong to Printer access, so they are only fetched while it is on. */
export function useGroupsIfAny(ws: string) {
  const active = useExtensionActive(ws, 'printer-access')
  return useQuery({ queryKey: qk.groups(ws), queryFn: () => accessApi.groups(ws), enabled: active })
}

/** Everything rules and limits name, for pickers and sentences. */
export function usePolicySources(ws: string) {
  const members = useMembers(ws).data ?? []
  const clients = useClients(ws).data ?? []
  const groups = useGroupsIfAny(ws).data ?? []
  const printers = useAddedPrinters(ws).data ?? []
  return { members, clients, groups, printers }
}
