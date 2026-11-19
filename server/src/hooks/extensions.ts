import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ExtensionId, WorkspaceExtension } from '@shared/extensions'
import { extensionsApi } from '@/lib/api/extensions'
import { refreshAccess } from '@/lib/cache'
import { qk } from '@/lib/query'

export function useExtensions(ws: string) {
  return useQuery({ queryKey: qk.extensions(ws), queryFn: () => extensionsApi.list(ws), staleTime: 5 * 60_000 })
}

/** Ids of the extensions in effect here; empty while loading, so extension UI never flashes in. */
export function useActiveExtensions(ws: string): ReadonlySet<ExtensionId> {
  const list = useExtensions(ws).data
  return new Set((list ?? []).filter((e) => e.active).map((e) => e.id))
}

export function useExtensionActive(ws: string, id: ExtensionId) {
  return useActiveExtensions(ws).has(id)
}

export function useSetExtensionEnabled(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: ExtensionId; enabled: boolean }) => extensionsApi.setEnabled(ws, id, enabled),
    onSuccess: (updated: WorkspaceExtension | undefined) => {
      if (updated?.id) qc.setQueryData<WorkspaceExtension[]>(qk.extensions(ws), (list) => list?.map((e) => (e.id === updated.id ? updated : e)))
      refreshAccess(qc, ws)
      qc.invalidateQueries({ queryKey: qk.adminExtensions })
    },
  })
}

export function useAdminExtensions() {
  return useQuery({ queryKey: qk.adminExtensions, queryFn: extensionsApi.instance })
}

export function useSetExtensionAvailable() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, available }: { id: ExtensionId; available: boolean }) => extensionsApi.setAvailable(id, available),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.adminExtensions })
      qc.invalidateQueries({ queryKey: ['ws'] })
    },
  })
}
