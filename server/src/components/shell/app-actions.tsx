import { createContext, useContext } from 'react'

export interface PrintRequest {
  printerId?: string
  file?: File
}

export interface AppActions {
  /** Opens the print dialog, optionally preselecting a printer or a dropped file. */
  openPrint: (request?: PrintRequest) => void
  openCommand: () => void
  openCustomize: () => void
  openNewWorkspace: () => void
}

export const AppActionsContext = createContext<AppActions | null>(null)

export function useAppActions(): AppActions {
  const actions = useContext(AppActionsContext)
  if (!actions) throw new Error('useAppActions() used outside the app shell')
  return actions
}

/** Absolute link into a workspace that works from any route depth (wouter `~` = from root). */
export const wsHref = (ws: string, path = '') => `~/w/${ws}${path === '/' ? '' : path}`
