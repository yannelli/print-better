import { lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react'
import { useRealtime } from '@/hooks/realtime'
import { WorkspaceContext } from '@/hooks/workspace'
import { type AppActions, AppActionsContext, type PrintRequest } from './app-actions'
import { CommandMenu } from './command-menu'
import { ConnectionBanner } from './connection-banner'
import { CustomizePanel } from './customize-panel'
import { NewWorkspaceDialog } from './new-workspace-dialog'
import { MobileBar, Sidebar } from './sidebar'

const PrintDialog = lazy(() => import('@/routes/print/print-dialog'))

export function AppShell({ ws, children }: { ws: string; children: ReactNode }) {
  useRealtime(ws)
  const [print, setPrint] = useState<{ open: boolean; request: PrintRequest } | null>(null)
  const [command, setCommand] = useState(false)
  const [customize, setCustomize] = useState(false)
  const [newWorkspace, setNewWorkspace] = useState(false)

  const actions = useMemo<AppActions>(
    () => ({
      openPrint: (request = {}) => setPrint({ open: true, request }),
      openCommand: () => setCommand(true),
      openCustomize: () => setCustomize(true),
      openNewWorkspace: () => setNewWorkspace(true),
    }),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommand((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <WorkspaceContext.Provider value={ws}>
      <AppActionsContext.Provider value={actions}>
        <a
          href="#main"
          className="sr-only z-50 rounded-full bg-foreground px-5 py-3 text-background focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <div className="flex min-h-dvh">
          <Sidebar ws={ws} />
          <div className="flex min-w-0 flex-1 flex-col">
            <ConnectionBanner />
            <MobileBar ws={ws} />
            <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 outline-none sm:px-8 lg:px-12 lg:py-12">
              {children}
            </main>
          </div>
        </div>
        <CommandMenu ws={ws} open={command} onOpenChange={setCommand} />
        <CustomizePanel open={customize} onOpenChange={setCustomize} />
        <NewWorkspaceDialog open={newWorkspace} onOpenChange={setNewWorkspace} />
        {print && (
          <Suspense fallback={null}>
            <PrintDialog
              ws={ws}
              open={print.open}
              request={print.request}
              onOpenChange={(open) => setPrint((p) => (p ? { ...p, open } : p))}
            />
          </Suspense>
        )}
      </AppActionsContext.Provider>
    </WorkspaceContext.Provider>
  )
}
