import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext } from 'react'
import type { Role, WorkspaceSummary } from '@shared/types'
import { type WorkspaceSettingsPatch, workspacesApi } from '@/lib/api/workspaces'
import type { SessionState } from '@/lib/api/types'
import { putWorkspace } from '@/lib/cache'
import { qk } from '@/lib/query'
import { useSession } from './auth'

export const WorkspaceContext = createContext<string | null>(null)

/** The workspace id from the `/w/:ws` route. Only valid inside the app shell. */
export function useWs(): string {
  const ws = useContext(WorkspaceContext)
  if (!ws) throw new Error('useWs() used outside a workspace route')
  return ws
}

export function useOptionalWs() {
  return useContext(WorkspaceContext)
}

const LAST_WS = 'pb-last-workspace'
export const rememberWorkspace = (id: string) => localStorage.setItem(LAST_WS, id)

export function preferredWorkspace(workspaces: WorkspaceSummary[]): WorkspaceSummary | undefined {
  const last = localStorage.getItem(LAST_WS)
  return workspaces.find((w) => w.id === last) ?? workspaces[0]
}

export function useWorkspaceSummary(id?: string) {
  const current = useOptionalWs()
  const ws = id ?? current
  return useSession().data?.workspaces.find((w) => w.id === ws)
}

export function useRole(): Role | undefined {
  return useWorkspaceSummary()?.role
}

/** Admins and owners manage devices, printers, members and settings. */
export function useCanManage() {
  const role = useRole()
  return role === 'owner' || role === 'admin'
}

export function useWorkspace(ws: string) {
  return useQuery({ queryKey: qk.workspace(ws), queryFn: () => workspacesApi.get(ws) })
}

export function useUpdateWorkspace(ws: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: { name?: string; settings?: WorkspaceSettingsPatch }) => workspacesApi.update(ws, patch),
    onSuccess: (workspace) => putWorkspace(qc, workspace),
    meta: { success: 'Saved' },
  })
}

export function useCreateWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => workspacesApi.create(name),
    onSuccess: (workspace) => {
      qc.setQueryData<SessionState>(qk.session, (s) =>
        s && { ...s, workspaces: [...s.workspaces, { id: workspace.id, name: workspace.name, role: workspace.role }] },
      )
      qc.setQueryData(qk.workspace(workspace.id), workspace)
      rememberWorkspace(workspace.id)
    },
  })
}

export function useDeleteWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ws: string) => workspacesApi.remove(ws),
    onSuccess: (_d, ws) => {
      qc.setQueryData<SessionState>(qk.session, (s) => s && { ...s, workspaces: s.workspaces.filter((w) => w.id !== ws) })
      qc.removeQueries({ queryKey: qk.ws(ws) })
    },
  })
}
