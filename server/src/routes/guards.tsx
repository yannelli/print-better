import { type ReactNode, useEffect } from 'react'
import { Redirect, useParams } from 'wouter'
import { AppShell } from '@/components/shell/app-shell'
import { Loading } from '@/components/states'
import { loginHref, useInstance, useSession } from '@/hooks/auth'
import { preferredWorkspace, rememberWorkspace } from '@/hooks/workspace'
import { workspaceScreenHref } from '@/lib/app-links'

export function FullPageLoading() {
  return <Loading className="min-h-dvh" />
}

/** Sends people to first-run setup or sign-in before rendering protected screens. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const instance = useInstance()
  const session = useSession()
  if (instance.data?.setupRequired) return <Redirect to="~/setup" replace />
  if (session.isPending) return <FullPageLoading />
  if (!session.data?.user) return <Redirect to={`~${loginHref()}`} replace />
  return <>{children}</>
}

export function RootRedirect() {
  const session = useSession()
  const workspaces = session.data?.workspaces ?? []
  const target = preferredWorkspace(workspaces)
  return (
    <RequireAuth>
      <Redirect to={target ? `~/w/${target.id}` : '~/welcome'} replace />
    </RequireAuth>
  )
}

/** `/printers` and the other workspace-free links open that screen in the workspace the root redirect would pick. */
export function WorkspaceScreenRedirect() {
  const session = useSession()
  const target = preferredWorkspace(session.data?.workspaces ?? [])
  const href = workspaceScreenHref(location.pathname, target?.id, location.search + location.hash)
  return (
    <RequireAuth>
      <Redirect to={`~${href}`} replace />
    </RequireAuth>
  )
}

function WorkspaceGate({ children }: { children: ReactNode }) {
  const { ws } = useParams<{ ws: string }>()
  const session = useSession()
  const member = session.data?.workspaces.some((w) => w.id === ws)
  useEffect(() => {
    if (member) rememberWorkspace(ws)
  }, [member, ws])
  if (!member) return <Redirect to="~/" replace />
  return <AppShell ws={ws}>{children}</AppShell>
}

/** Workspace screens under `/w/:ws`. */
export function WorkspaceRoute({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <WorkspaceGate>{children}</WorkspaceGate>
    </RequireAuth>
  )
}

function UserShell({ children }: { children: ReactNode }) {
  const workspaces = useSession().data?.workspaces ?? []
  const ws = preferredWorkspace(workspaces)
  if (!ws) return <Redirect to="~/welcome" replace />
  return <AppShell ws={ws.id}>{children}</AppShell>
}

/** Account-level screens (account, admin, connect) still get the shell of the last-used workspace. */
export function UserRoute({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <UserShell>{children}</UserShell>
    </RequireAuth>
  )
}
