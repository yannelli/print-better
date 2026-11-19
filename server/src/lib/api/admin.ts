import type { InstanceSettings, User } from '@shared/types'
import { enc, http, items } from './http'
import type { OAuthRequestInfo } from './types'

/** Secrets are write-only: a string sets, null clears, omitted keeps. */
export interface InstanceSettingsPatch {
  appName?: string
  signup?: InstanceSettings['signup']
  sso?: {
    google?: { enabled?: boolean; clientId?: string | null; clientSecret?: string | null }
    oidc?: {
      enabled?: boolean
      name?: string | null
      issuer?: string | null
      clientId?: string | null
      clientSecret?: string | null
    }
  }
  email?: Partial<Omit<InstanceSettings['email'], 'hasApiKey' | 'hasWebhookSecret'>> & {
    apiKey?: string | null
    webhookSecret?: string | null
  }
}

export const adminApi = {
  settings: () => http.get<InstanceSettings>('/admin/settings'),
  updateSettings: (patch: InstanceSettingsPatch) => http.patch<InstanceSettings>('/admin/settings', patch),
  users: async () => items(await http.get<User[] | { items: User[] }>('/admin/users')),
  updateUser: (id: string, patch: { isAdmin?: boolean }) => http.patch<User>(`/admin/users/${enc(id)}`, patch),
  resetPassword: (id: string) => http.post<{ url: string }>(`/admin/users/${enc(id)}/reset-password`),
  deleteUser: (id: string) => http.del(`/admin/users/${enc(id)}`),
}

export const oauthApi = {
  request: (id: string) => http.get<OAuthRequestInfo>(`/oauth/requests/${enc(id)}`),
  approve: (id: string, workspaceId: string | null) =>
    http.post<{ redirectTo: string }>(`/oauth/requests/${enc(id)}/approve`, { workspaceId }),
  deny: (id: string) => http.post<{ redirectTo: string }>(`/oauth/requests/${enc(id)}/deny`),
}
