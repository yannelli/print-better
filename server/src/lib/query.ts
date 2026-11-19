import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, errorMessage } from './api/http'
import type { JobFilters, SessionState } from './api/types'

export const qk = {
  instance: ['instance'] as const,
  session: ['session'] as const,
  me: ['me'] as const,
  passkeys: ['me', 'passkeys'] as const,
  sessions: ['me', 'sessions'] as const,
  tokens: ['me', 'tokens'] as const,
  identities: ['me', 'identities'] as const,
  adminSettings: ['admin', 'settings'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminExtensions: ['admin', 'extensions'] as const,
  downloads: ['downloads'] as const,
  ws: (ws: string) => ['ws', ws] as const,
  workspace: (ws: string) => ['ws', ws, 'workspace'] as const,
  printers: (ws: string) => ['ws', ws, 'printers'] as const,
  printer: (ws: string, id: string) => ['ws', ws, 'printer', id] as const,
  jobs: (ws: string, filters: JobFilters = {}) => ['ws', ws, 'jobs', filters] as const,
  jobsAll: (ws: string) => ['ws', ws, 'jobs'] as const,
  job: (ws: string, id: string) => ['ws', ws, 'job', id] as const,
  clients: (ws: string) => ['ws', ws, 'clients'] as const,
  members: (ws: string) => ['ws', ws, 'members'] as const,
  invites: (ws: string) => ['ws', ws, 'invites'] as const,
  enrollments: (ws: string) => ['ws', ws, 'enrollments'] as const,
  audit: (ws: string) => ['ws', ws, 'audit'] as const,
  extensions: (ws: string) => ['ws', ws, 'extensions'] as const,
  /** Prefix of every printer access query, including `myAccess`. */
  access: (ws: string) => ['ws', ws, 'access'] as const,
  myAccess: (ws: string) => ['ws', ws, 'access', 'me'] as const,
  groups: (ws: string) => ['ws', ws, 'groups'] as const,
  /** Prefix of everything a `usage` event refreshes: prices, previews, limits and what they counted. */
  usage: (ws: string) => ['ws', ws, 'usage'] as const,
  prices: (ws: string) => ['ws', ws, 'usage', 'prices'] as const,
  jobPreview: (ws: string, request: unknown) => ['ws', ws, 'usage', 'preview', request] as const,
  myUsage: (ws: string) => ['ws', ws, 'usage', 'me'] as const,
  limits: (ws: string) => ['ws', ws, 'usage', 'limits'] as const,
  cycleUsage: (ws: string, cycle: 'current' | 'previous') => ['ws', ws, 'usage', 'cycle', cycle] as const,
  allowances: (ws: string, limitId: string) => ['ws', ws, 'usage', 'allowances', limitId] as const,
  rules: (ws: string) => ['ws', ws, 'rules'] as const,
  /** Prefix of Enterprise controls' settings, cost centers and held jobs; an `access` event refreshes it. */
  enterprise: (ws: string) => ['ws', ws, 'enterprise'] as const,
  /** Jobs waiting for approval or release; job and approval events refresh it. */
  holds: (ws: string) => ['ws', ws, 'enterprise', 'holds'] as const,
}

declare module '@tanstack/react-query' {
  interface Register {
    defaultError: Error
    mutationMeta: { quiet?: boolean; success?: string }
  }
}

function signedOut(client: QueryClient) {
  client.setQueryData<SessionState>(qk.session, { user: null, workspaces: [] })
}

export function createQueryClient() {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (error instanceof ApiError && error.isUnauthorized && query.queryKey[0] !== 'session') signedOut(client)
      },
    }),
    mutationCache: new MutationCache({
      onSuccess: (_data, _vars, _ctx, mutation) => {
        if (mutation.meta?.success) toast.success(mutation.meta.success)
      },
      onError: (error, _vars, _ctx, mutation) => {
        if (error instanceof ApiError && error.isUnauthorized) signedOut(client)
        if (!mutation.meta?.quiet) toast.error(errorMessage(error))
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
    },
  })
  return client
}
