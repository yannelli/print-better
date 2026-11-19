import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SessionState } from '@/lib/api/types'
import { type CreateTokenInput, meApi } from '@/lib/api/me'
import { adminApi, type InstanceSettingsPatch } from '@/lib/api/admin'
import { qk } from '@/lib/query'

export function useUpdateMe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: meApi.update,
    onSuccess: (user) => qc.setQueryData<SessionState>(qk.session, (s) => s && { ...s, user }),
    meta: { success: 'Profile saved' },
  })
}

export function useSetPassword() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ next, current }: { next: string; current?: string }) => meApi.setPassword(next, current),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.session }),
    meta: { success: 'Password changed' },
  })
}

export function usePasskeys() {
  return useQuery({ queryKey: qk.passkeys, queryFn: meApi.passkeys })
}

export function useSessions() {
  return useQuery({ queryKey: qk.sessions, queryFn: meApi.sessions })
}

export function useIdentities() {
  return useQuery({ queryKey: qk.identities, queryFn: meApi.identities })
}

/** Quiet: the email row shows the result inline, including rate-limit messages. */
export const useSendVerification = () => useMutation({ mutationFn: meApi.sendVerification, meta: { quiet: true } })

export function useTokens() {
  return useQuery({ queryKey: qk.tokens, queryFn: meApi.tokens })
}

/** Generic "call then refetch a list" mutation for the account pages. */
function useListMutation<V, R>(key: readonly unknown[], fn: (v: V) => Promise<R>, success?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    meta: success ? { success } : undefined,
  })
}

export const useRenamePasskey = () =>
  useListMutation(qk.passkeys, ({ id, name }: { id: string; name: string }) => meApi.renamePasskey(id, name), 'Passkey renamed')
export const useDeletePasskey = () => useListMutation(qk.passkeys, meApi.deletePasskey, 'Passkey removed')
export const useUnlinkIdentity = () => useListMutation(qk.identities, meApi.unlinkIdentity, 'Account disconnected')
export const useEndSession = () => useListMutation(qk.sessions, meApi.endSession, 'Signed out that session')
export const useCreateToken = () => useListMutation(qk.tokens, (input: CreateTokenInput) => meApi.createToken(input))
export const useDeleteToken = () => useListMutation(qk.tokens, meApi.deleteToken, 'Access removed')
export const useRecoveryCodes = () => useMutation({ mutationFn: meApi.recoveryCodes })

export function useAdminSettings(enabled = true) {
  return useQuery({ queryKey: qk.adminSettings, queryFn: adminApi.settings, enabled })
}

export function useUpdateAdminSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: InstanceSettingsPatch) => adminApi.updateSettings(patch),
    onSuccess: (settings) => {
      qc.setQueryData(qk.adminSettings, settings)
      qc.invalidateQueries({ queryKey: qk.instance })
    },
    meta: { success: 'Saved' },
  })
}

export function useAdminUsers(enabled = true) {
  return useQuery({ queryKey: qk.adminUsers, queryFn: adminApi.users, enabled })
}

export const useUpdateAdminUser = () =>
  useListMutation(qk.adminUsers, ({ id, isAdmin }: { id: string; isAdmin: boolean }) => adminApi.updateUser(id, { isAdmin }), 'Saved')
export const useDeleteAdminUser = () => useListMutation(qk.adminUsers, adminApi.deleteUser, 'Account deleted')
export const useAdminResetPassword = () => useMutation({ mutationFn: adminApi.resetPassword })
