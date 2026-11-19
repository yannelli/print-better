import type { ApiToken, IdentityList, Passkey, SessionInfo, User } from '@shared/types'
import { enc, http, items } from './http'

export interface CreateTokenInput {
  name: string
  workspaceId?: string
  expiresInDays?: number
}

export const meApi = {
  get: () => http.get<User>('/me'),
  update: (patch: { name?: string; email?: string | null; username?: string }) => http.patch<User>('/me', patch),
  setPassword: (next: string, current?: string) => http.put<void>('/me/password', { current, next }),
  sendVerification: () => http.post<void>('/me/email/verification'),

  identities: () => http.get<IdentityList>('/me/identities'),
  unlinkIdentity: (provider: string) => http.del(`/me/identities/${enc(provider)}`),

  passkeys: async () => items(await http.get<Passkey[] | { items: Passkey[] }>('/me/passkeys')),
  renamePasskey: (id: string, name: string) => http.patch<Passkey>(`/me/passkeys/${enc(id)}`, { name }),
  deletePasskey: (id: string) => http.del(`/me/passkeys/${enc(id)}`),

  sessions: async () => items(await http.get<SessionInfo[] | { items: SessionInfo[] }>('/me/sessions')),
  endSession: (id: string) => http.del(`/me/sessions/${enc(id)}`),

  recoveryCodes: () => http.post<{ codes: string[] }>('/me/recovery-codes'),

  tokens: async () => items(await http.get<ApiToken[] | { items: ApiToken[] }>('/me/tokens')),
  createToken: (input: CreateTokenInput) => http.post<{ token: string; apiToken: ApiToken }>('/me/tokens', input),
  deleteToken: (id: string) => http.del(`/me/tokens/${enc(id)}`),
}
