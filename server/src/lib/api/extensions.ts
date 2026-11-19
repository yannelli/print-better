import type { ExtensionId, InstanceExtension, WorkspaceExtension } from '@shared/extensions'
import { enc, http, items } from './http'

export const extensionsApi = {
  list: async (ws: string) =>
    items(await http.get<WorkspaceExtension[] | { items: WorkspaceExtension[] }>(`/workspaces/${enc(ws)}/extensions`)),
  setEnabled: (ws: string, id: ExtensionId, enabled: boolean) =>
    http.patch<WorkspaceExtension>(`/workspaces/${enc(ws)}/extensions/${enc(id)}`, { enabled }),
  instance: async () => items(await http.get<InstanceExtension[] | { items: InstanceExtension[] }>('/admin/extensions')),
  setAvailable: (id: ExtensionId, available: boolean) => http.patch<InstanceExtension>(`/admin/extensions/${enc(id)}`, { available }),
}
