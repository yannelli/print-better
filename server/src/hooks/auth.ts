import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useLocation } from 'wouter'
import { authApi } from '@/lib/api/auth'
import type { SessionState } from '@/lib/api/types'
import { qk } from '@/lib/query'

export function useInstance() {
  return useQuery({ queryKey: qk.instance, queryFn: authApi.instance, staleTime: 5 * 60_000 })
}

export function useSession() {
  return useQuery({ queryKey: qk.session, queryFn: authApi.session, staleTime: 60_000 })
}

export function useUser() {
  return useSession().data?.user ?? null
}

/** Only same-origin paths, so `?next=` can never bounce someone to another site. */
export function safeNext(next: string | null | undefined, fallback = '/') {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  return next
}

export function loginHref(next?: string) {
  const target = next ?? location.pathname + location.search
  return target && target !== '/' ? `/login?next=${encodeURIComponent(target)}` : '/login'
}

/** Refreshes the session after any sign-in path, then leaves the auth screens. */
export function useAfterSignIn() {
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  return useCallback(
    async (next?: string | null) => {
      const session = await qc.fetchQuery({ queryKey: qk.session, queryFn: authApi.session, staleTime: 0 })
      qc.invalidateQueries({ queryKey: qk.instance })
      navigate(`~${safeNext(next, session.workspaces.length ? '/' : '/welcome')}`, { replace: true })
    },
    [qc, navigate],
  )
}

export function useSignOut() {
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  return useCallback(async () => {
    await authApi.logout().catch(() => undefined)
    qc.clear()
    qc.setQueryData<SessionState>(qk.session, { user: null, workspaces: [] })
    navigate('~/login', { replace: true })
  }, [qc, navigate])
}
