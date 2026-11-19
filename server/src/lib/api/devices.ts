import type { Client, ClientSettings, Enrollment, EnrollmentToken } from '@shared/types'
import type { CommandName } from '@shared/protocol'
import { enc, http, items } from './http'
import type { CommandResult, DeviceCodeInfo, DownloadManifest } from './types'

export type ClientSettingsPatch = Omit<Partial<ClientSettings>, 'discovery'> & {
  discovery?: Partial<ClientSettings['discovery']>
}

const base = (ws: string) => `/workspaces/${enc(ws)}`

export const devicesApi = {
  list: async (ws: string) => items(await http.get<Client[] | { items: Client[] }>(`${base(ws)}/clients`)),
  update: (ws: string, id: string, patch: { name?: string; settings?: ClientSettingsPatch }) =>
    http.patch<Client>(`${base(ws)}/clients/${enc(id)}`, patch),
  remove: (ws: string, id: string) => http.del(`${base(ws)}/clients/${enc(id)}`),
  command: <T = unknown>(ws: string, id: string, name: CommandName, args?: Record<string, unknown>) =>
    http.post<CommandResult<T>>(`${base(ws)}/clients/${enc(id)}/commands`, { name, args }),

  createEnrollment: (ws: string, input: { label?: string; maxUses?: number; ttlHours?: number } = {}) =>
    http.post<Enrollment>(`${base(ws)}/enrollments`, input),
  enrollments: async (ws: string) =>
    items(await http.get<EnrollmentToken[] | { items: EnrollmentToken[] }>(`${base(ws)}/enrollments`)),
  deleteEnrollment: (ws: string, id: string) => http.del(`${base(ws)}/enrollments/${enc(id)}`),

  deviceCode: (userCode: string) => http.get<DeviceCodeInfo>(`/device/${enc(userCode)}`),
  approveDevice: (userCode: string, workspaceId: string, name: string) =>
    http.post<void>(`/device/${enc(userCode)}/approve`, { workspaceId, name }),
  denyDevice: (userCode: string) => http.post<void>(`/device/${enc(userCode)}/deny`),
}

/** Public downloads manifest served by the Worker outside /api. */
export async function fetchDownloads(): Promise<DownloadManifest | null> {
  const res = await fetch('/dl/latest.json').catch(() => null)
  if (!res?.ok) return null
  return (await res.json()) as DownloadManifest
}

export const downloadUrl = (manifest: DownloadManifest, name: string) => `/dl/${enc(manifest.version)}/${enc(name)}`
