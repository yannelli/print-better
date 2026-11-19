import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Role } from '@shared/types'
import { workspacesApi } from '@/lib/api/workspaces'
import { qk } from '@/lib/query'

export function useMembers(ws: string) {
  return useQuery({ queryKey: qk.members(ws), queryFn: () => workspacesApi.members(ws) })
}

export function useInvites(ws: string, enabled = true) {
  return useQuery({ queryKey: qk.invites(ws), queryFn: () => workspacesApi.invites(ws), enabled })
}

export function useSetRole(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) => workspacesApi.setRole(ws, userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members(ws) }),
    meta: { success: 'Role changed' },
  })
}

export function useRemoveMember(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => workspacesApi.removeMember(ws, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.members(ws) })
      qc.invalidateQueries({ queryKey: qk.session })
    },
  })
}

export function useCreateInvite(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { role: Role; email?: string }) => workspacesApi.createInvite(ws, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invites(ws) }),
  })
}

export function useDeleteInvite(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => workspacesApi.deleteInvite(ws, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invites(ws) }),
    meta: { success: 'Invite canceled' },
  })
}

export function useAudit(ws: string) {
  return useInfiniteQuery({
    queryKey: qk.audit(ws),
    queryFn: ({ pageParam }) => workspacesApi.audit(ws, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((p) => p.items),
  })
}
