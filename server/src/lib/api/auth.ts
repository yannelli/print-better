import type { InstanceInfo, Passkey, User } from '@shared/types'
import { enc, http, qs } from './http'
import type { ChallengeOptions, SessionState } from './types'

type CreationOptions = ChallengeOptions<PublicKeyCredentialCreationOptionsJSON>
type RequestOptions = ChallengeOptions<PublicKeyCredentialRequestOptionsJSON>

export interface SetupInput {
  setupToken: string
  username: string
  name: string
  password?: string
  workspaceName: string
}

export interface RegisterInput {
  username: string
  name: string
  password: string
  email?: string
  inviteToken?: string
}

export const authApi = {
  instance: () => http.get<InstanceInfo>('/instance'),
  session: () => http.get<SessionState>('/auth/session'),
  setup: (input: SetupInput) => http.post<{ user: User }>('/auth/setup', input),
  register: (input: RegisterInput) => http.post<{ user: User }>('/auth/register', input),
  login: (login: string, password: string) => http.post<{ user: User }>('/auth/login', { login, password }),
  logout: () => http.post<void>('/auth/logout'),
  recover: (input: { login: string; code: string; newPassword?: string }) =>
    http.post<{ user: User }>('/auth/recover', input),
  resetRequest: (email: string) => http.post<void>('/auth/reset/request', { email }),
  resetConfirm: (token: string, password: string) => http.post<void>('/auth/reset/confirm', { token, password }),
  /** `user` comes back only when the browser is signed in as the account being verified. */
  verifyEmail: (token: string) => http.post<{ user?: User }>('/auth/verify-email', { token }),

  passkeyRegisterOptions: () => http.post<CreationOptions>('/auth/passkey/register/options'),
  passkeyRegisterVerify: (challengeId: string, credential: unknown, name?: string) =>
    http.post<Passkey>('/auth/passkey/register/verify', { challengeId, credential, name }),
  /** With `setupToken` + `workspaceName` while setup is required, this creates the first account. */
  passkeySignupOptions: (input: {
    username: string
    name: string
    inviteToken?: string
    setupToken?: string
    workspaceName?: string
  }) =>
    http.post<CreationOptions>('/auth/passkey/signup/options', input),
  passkeySignupVerify: (challengeId: string, credential: unknown) =>
    http.post<{ user: User }>('/auth/passkey/signup/verify', { challengeId, credential }),
  passkeyLoginOptions: (login?: string) => http.post<RequestOptions>('/auth/passkey/login/options', { login }),
  passkeyLoginVerify: (challengeId: string, credential: unknown) =>
    http.post<{ user: User }>('/auth/passkey/login/verify', { challengeId, credential }),
}

/** Full-page navigation; failures come back as `/login?error=<code>&message=<text>`. */
export function ssoStartUrl(provider: string, next?: string | null, invite?: string | null) {
  return `/api/auth/sso/${enc(provider)}/start${qs({ next, invite })}`
}

/** Connects the provider to the signed-in account; failures come back as `<next>?error=<code>&message=<text>`. */
export function ssoLinkUrl(provider: string, next: string) {
  return `/api/auth/sso/${enc(provider)}/start${qs({ link: 1, next })}`
}
