/** Workspace screens that also open without a workspace id, so the docs can link to them. */
export const WORKSPACE_FREE_PATHS = ['/printers', '/jobs', '/devices', '/devices/add', '/members', '/settings'] as const

/** Workspace settings tabs, so `/settings/<tab>` opens that tab. */
export const SETTINGS_TABS = ['general', 'printing', 'email', 'printer-access', 'enterprise', 'extensions', 'activity'] as const

/** Screens outside any workspace, with or without a tab after them. */
export const ACCOUNT_PATHS = ['/account', '/admin', '/connect'] as const

const workspaceFree = [...WORKSPACE_FREE_PATHS, ...SETTINGS_TABS.map((tab) => `/settings/${tab}`)]

export const WORKSPACE_FREE_ROUTE = new RegExp(`^(${workspaceFree.join('|')})/?$`)

export const ACCOUNT_ROUTE = new RegExp(`^(${ACCOUNT_PATHS.join('|')})(/.*)?$`)

/** The same screen in a workspace, or `/welcome` for someone without one yet. */
export function workspaceScreenHref(pathname: string, workspaceId: string | undefined, suffix = ''): string {
  return workspaceId ? `/w/${workspaceId}${pathname.replace(/\/+$/, '')}${suffix}` : '/welcome'
}
