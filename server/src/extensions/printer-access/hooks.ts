import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AccessSubject } from '@shared/access'
import { useClients } from '@/hooks/devices'
import { useExtensionActive } from '@/hooks/extensions'
import { useMembers } from '@/hooks/members'
import { refreshAccess } from '@/lib/cache'
import { qk } from '@/lib/query'
import { accessApi, type RoleInput, subjectParam } from './api'
import type { SubjectSources } from './subjects'

const keys = {
  workspace: (ws: string) => [...qk.access(ws), 'workspace'] as const,
  summaries: (ws: string) => [...qk.access(ws), 'printers'] as const,
  printer: (ws: string, id: string) => [...qk.access(ws), 'printer', id] as const,
  explain: (ws: string, printerId: string, subject: AccessSubject) => [...qk.access(ws), 'explain', printerId, subjectParam(subject)] as const,
}

export const useWorkspaceAccess = (ws: string) => useQuery({ queryKey: keys.workspace(ws), queryFn: () => accessApi.workspace(ws) })

/** Summaries for lock badges; never fetched while the extension is off. */
export function useAccessSummaries(ws: string) {
  const active = useExtensionActive(ws, 'printer-access')
  return useQuery({ queryKey: keys.summaries(ws), queryFn: () => accessApi.summaries(ws), enabled: active })
}

export const usePrinterAccess = (ws: string, printerId: string) =>
  useQuery({ queryKey: keys.printer(ws, printerId), queryFn: () => accessApi.printer(ws, printerId) })

export const useExplain = (ws: string, printerId: string, subject: AccessSubject | null) =>
  useQuery({
    queryKey: keys.explain(ws, printerId, subject ?? { type: 'everyone' }),
    queryFn: () => accessApi.explain(ws, printerId, subject!),
    enabled: !!subject,
  })

/** One explanation per printer for the same subject, e.g. a device across every printer. */
export const useExplainMany = (ws: string, printerIds: string[], subject: AccessSubject) =>
  useQueries({
    queries: printerIds.map((id) => ({ queryKey: keys.explain(ws, id, subject), queryFn: () => accessApi.explain(ws, id, subject) })),
  })

export const useGroups = (ws: string) => useQuery({ queryKey: qk.groups(ws), queryFn: () => accessApi.groups(ws) })

const NONE: never[] = []

/** Members, groups, and devices, for pickers and names. Empty lists until loaded. */
export function useSubjectSources(ws: string): SubjectSources & { pending: boolean } {
  const members = useMembers(ws)
  const groups = useGroups(ws)
  const clients = useClients(ws)
  return {
    members: members.data ?? NONE,
    groups: groups.data ?? NONE,
    clients: clients.data ?? NONE,
    pending: members.isPending || groups.isPending || clients.isPending,
  }
}

/** Any access change: refetch everything access touches, like the `access` event does. */
function useAccessMutation<V>(ws: string, fn: (v: V) => Promise<unknown>, success?: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => refreshAccess(qc, ws), meta: success ? { success } : undefined })
}

export const useSetDefaultRole = (ws: string) => useAccessMutation(ws, (role: string) => accessApi.setDefaultRole(ws, role), 'Default saved')
export const useSetEveryone = (ws: string, printerId: string) =>
  useAccessMutation(ws, (role: string | null) => accessApi.setEveryone(ws, printerId, role), 'Access saved')

export const useCreateRole = (ws: string) => useAccessMutation(ws, (input: RoleInput) => accessApi.createRole(ws, input), 'Role created')
export const useUpdateRole = (ws: string) =>
  useAccessMutation(ws, ({ id, input }: { id: string; input: RoleInput }) => accessApi.updateRole(ws, id, input), 'Role saved')
export const useDeleteRole = (ws: string) => useAccessMutation(ws, (id: string) => accessApi.deleteRole(ws, id), 'Role deleted')

export interface GrantInput {
  subject: AccessSubject
  role: string
}

/** `printerId` null: a grant on every printer. */
export const useGrant = (ws: string, printerId: string | null) =>
  useAccessMutation(
    ws,
    ({ subject, role }: GrantInput) =>
      printerId ? accessApi.grantPrinter(ws, printerId, subject, role) : accessApi.grantEveryPrinter(ws, subject, role),
    'Access saved',
  )
export const useRevoke = (ws: string) => useAccessMutation(ws, (grantId: string) => accessApi.revoke(ws, grantId), 'Access removed')

export const useCreateGroup = (ws: string) =>
  useAccessMutation(ws, (input: { name: string; description: string | null }) => accessApi.createGroup(ws, input), 'Group created')
export const useUpdateGroup = (ws: string) =>
  useAccessMutation(
    ws,
    ({ id, input }: { id: string; input: { name: string; description: string | null } }) => accessApi.updateGroup(ws, id, input),
    'Group saved',
  )
export const useDeleteGroup = (ws: string) => useAccessMutation(ws, (id: string) => accessApi.deleteGroup(ws, id), 'Group deleted')
export const useSetGroupMember = (ws: string) =>
  useAccessMutation(
    ws,
    ({ groupId, member, inGroup }: { groupId: string; member: { type: 'user' | 'client'; id: string }; inGroup: boolean }) =>
      accessApi.setGroupMember(ws, groupId, member, inGroup),
  )
