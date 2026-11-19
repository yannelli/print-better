import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Client } from '@shared/types'
import type { CommandName } from '@shared/protocol'
import { type ClientSettingsPatch, devicesApi, fetchDownloads } from '@/lib/api/devices'
import { dropClient, putClient } from '@/lib/cache'
import { qk } from '@/lib/query'

export function useClients(ws: string) {
  return useQuery({ queryKey: qk.clients(ws), queryFn: () => devicesApi.list(ws) })
}

export function useClient(ws: string, id: string) {
  return useQuery({
    queryKey: qk.clients(ws),
    queryFn: () => devicesApi.list(ws),
    select: (list: Client[]) => list.find((c) => c.id === id) ?? null,
  })
}

export function useUpdateClient(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; settings?: ClientSettingsPatch } }) =>
      devicesApi.update(ws, id, patch),
    onSuccess: (client) => putClient(qc, ws, client),
  })
}

export function useRemoveClient(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => devicesApi.remove(ws, id),
    onSuccess: (_d, id) => dropClient(qc, ws, id),
    meta: { success: 'Device removed' },
  })
}

function commandError(error: string | undefined) {
  if (error === 'timeout') return "The device didn't answer in time. Check that it's on, then try again."
  return error ?? 'The device could not finish that.'
}

/** Runs a command on a device; a failed command result is surfaced as an error. */
export function useClientCommand<T = unknown>(ws: string) {
  return useMutation({
    mutationFn: async ({ id, name, args }: { id: string; name: CommandName; args?: Record<string, unknown> }) => {
      const result = await devicesApi.command<T>(ws, id, name, args)
      if (!result.ok) throw new Error(commandError(result.error))
      return result.data as T
    },
  })
}

export function useEnrollments(ws: string, enabled = true) {
  return useQuery({ queryKey: qk.enrollments(ws), queryFn: () => devicesApi.enrollments(ws), enabled })
}

export function useCreateEnrollment(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { label?: string; maxUses?: number; ttlHours?: number } = {}) =>
      devicesApi.createEnrollment(ws, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.enrollments(ws) }),
  })
}

export function useDeleteEnrollment(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => devicesApi.deleteEnrollment(ws, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.enrollments(ws) }),
  })
}

export function useDownloads() {
  return useQuery({ queryKey: qk.downloads, queryFn: fetchDownloads, staleTime: 10 * 60_000 })
}
