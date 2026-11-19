/** Optional modules (docs/extensions.md). An instance admin makes one available, then a workspace owner turns it on. */
export type ExtensionId = 'printer-access' | 'print-policies' | 'enterprise'

export interface ExtensionInfo {
  id: ExtensionId
  name: string
  /** One sentence for settings pages. */
  summary: string
  /** Docs path in the repository, linked from settings pages. */
  docs: string
}

export const EXTENSIONS: readonly ExtensionInfo[] = [
  {
    id: 'printer-access',
    name: 'Printer access',
    summary: 'Choose who can see, print to, and manage each printer, with groups, device rules, and custom roles.',
    docs: 'docs/printer-access.md',
  },
  {
    id: 'print-policies',
    name: 'Print rules and limits',
    summary: 'Check every job before it prints: rules that change, redirect, or stop jobs, and page, job, and cost limits per cycle.',
    docs: 'docs/print-policies.md',
  },
  {
    id: 'enterprise',
    name: 'Enterprise controls',
    summary: 'Approvals, secure release, cost centers and budgets, usage reports, alerts, and stricter retention and privacy.',
    docs: 'docs/enterprise.md',
  },
]

export const isExtensionId = (value: unknown): value is ExtensionId => EXTENSIONS.some((e) => e.id === value)

/** `GET /api/admin/extensions` (instance admins). */
export interface InstanceExtension extends ExtensionInfo {
  available: boolean
  /** Workspaces that turned it on; kept while unavailable, so making it available again restores them. */
  enabledWorkspaces: number
}

/** `GET /api/workspaces/:ws/extensions` (any member). */
export interface WorkspaceExtension extends ExtensionInfo {
  available: boolean
  enabled: boolean
  /** `available && enabled`: in effect for this workspace. */
  active: boolean
}
