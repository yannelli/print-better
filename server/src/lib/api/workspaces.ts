import type { AuditEntry, Invite, Member, Role, Workspace, WorkspaceSettings, WorkspaceSummary } from '@shared/types'
import { enc, http, items, qs } from './http'
import type { InvitePreview, Page } from './types'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }
export type WorkspaceSettingsPatch = DeepPartial<WorkspaceSettings>

const ws = (id: string) => `/workspaces/${enc(id)}`

export const workspacesApi = {
  list: async () => items(await http.get<WorkspaceSummary[] | { items: WorkspaceSummary[] }>('/workspaces')),
  create: (name: string) => http.post<Workspace>('/workspaces', { name }),
  get: (id: string) => http.get<Workspace>(ws(id)),
  update: (id: string, patch: { name?: string; settings?: WorkspaceSettingsPatch }) => http.patch<Workspace>(ws(id), patch),
  remove: (id: string) => http.del(ws(id)),

  members: async (id: string) => items(await http.get<Member[] | { items: Member[] }>(`${ws(id)}/members`)),
  setRole: (id: string, userId: string, role: Role) => http.patch<Member>(`${ws(id)}/members/${enc(userId)}`, { role }),
  removeMember: (id: string, userId: string) => http.del(`${ws(id)}/members/${enc(userId)}`),

  invites: async (id: string) => items(await http.get<Invite[] | { items: Invite[] }>(`${ws(id)}/invites`)),
  createInvite: (id: string, input: { role: Role; email?: string }) =>
    http.post<{ invite: Invite; url: string }>(`${ws(id)}/invites`, input),
  deleteInvite: (id: string, inviteId: string) => http.del(`${ws(id)}/invites/${enc(inviteId)}`),

  invitePreview: (token: string) => http.get<InvitePreview>(`/invites/${enc(token)}`),
  acceptInvite: (token: string) => http.post<WorkspaceSummary>(`/invites/${enc(token)}/accept`),

  audit: (id: string, cursor?: string) => http.get<Page<AuditEntry>>(`${ws(id)}/audit${qs({ cursor })}`),
}

export const eventsUrl = (id: string) => {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/api${ws(id)}/events`
}
