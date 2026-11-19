// Account, workspace, and instance types shared by the Worker and the SPA.
// JSON is camelCase; timestamps are Unix epoch milliseconds.

export * from './printing'

export type Role = 'owner' | 'admin' | 'member'
export type AutoAdd = 'smart' | 'all' | 'none'
export type Os = 'macos' | 'windows' | 'linux'

export interface User {
  id: string
  username: string
  name: string
  email: string | null
  emailVerified: boolean
  isAdmin: boolean
  hasPassword: boolean
  createdAt: number
}

export interface WorkspaceSummary {
  id: string
  name: string
  role: Role
}

export interface EmailToPrintSettings {
  enabled: boolean
  allowMembers: boolean
  /** Extra sender addresses or "@domain" entries. */
  allowlist: string[]
}

export interface WorkspaceSettings {
  autoAdd: AutoAdd
  keepDocumentsHours: number
  jobTimeoutHours: number
  maxUploadMb: number
  /** Default for newly paired clients. */
  lanSharing: boolean
  emailToPrint: EmailToPrintSettings
  defaultPrinterId: string | null
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  autoAdd: 'smart',
  keepDocumentsHours: 24,
  jobTimeoutHours: 24,
  maxUploadMb: 50,
  lanSharing: false,
  emailToPrint: { enabled: false, allowMembers: true, allowlist: [] },
  defaultPrinterId: null,
}

export interface Workspace {
  id: string
  name: string
  role: Role
  settings: WorkspaceSettings
  createdAt: number
}

export interface Member {
  userId: string
  username: string
  name: string
  email: string | null
  role: Role
  createdAt: number
}

export interface Invite {
  id: string
  role: Role
  email: string | null
  createdBy: string | null
  createdAt: number
  expiresAt: number
}

export interface ClientSettings {
  tray: boolean
  lanSharing: boolean
  autoAdd: AutoAdd | 'inherit'
  discovery: { mdns: boolean; snmp: boolean; usb: boolean; os: boolean }
  /** Jobs stay queued on the client while paused. */
  paused: boolean
  logLevel: 'info' | 'debug'
  /** Show the workspace's printers on other devices as local printers on this one (macOS, Linux). */
  remotePrinters: boolean
  /** Install new client releases without asking (macOS, Linux). */
  autoUpdate: boolean
  /** Workspace printer ids not offered on this computer even though `remotePrinters` is on. */
  remotePrintersHidden: string[]
  /** Workspace printer to make this computer's default printer; null leaves the default alone. */
  defaultPrinter: string | null
}

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  tray: true,
  lanSharing: false,
  autoAdd: 'inherit',
  discovery: { mdns: true, snmp: true, usb: true, os: true },
  paused: false,
  logLevel: 'info',
  remotePrinters: true,
  autoUpdate: true,
  remotePrintersHidden: [],
  defaultPrinter: null,
}

/** `added`: a Print Better system printer (`queue`); `hidden`: left out by `remotePrintersHidden`. */
export type SystemPrinterState = 'added' | 'hidden' | 'waiting' | 'error'

export interface SystemPrinter {
  /** Workspace printer id. */
  id: string
  state: SystemPrinterState
  /** The `pb_` queue, when added. */
  queue: string | null
  /** A queue for the same printer set up on this computer without Print Better (matched by uuid). */
  installed: string | null
  /** This computer finds the printer on its own network too. */
  direct: boolean
}

/** Why `ClientSettings.defaultPrinter` is not this computer's default yet. */
export type DefaultPrinterProblem = 'hidden' | 'waiting' | 'unavailable' | 'failed'

/** A desktop's remote printers and default printer as its print system has them (reported by the device). */
export interface SystemPrinters {
  /** Remote printers are on and served on this computer. */
  active: boolean
  /** Why remote printers or the default printer could not be set up. */
  error: string | null
  printers: SystemPrinter[]
  /** The computer's default print queue, and the workspace printer behind it when there is one. */
  defaultQueue: string | null
  defaultPrinterId: string | null
  defaultProblem: DefaultPrinterProblem | null
  /** macOS "Default printer: Last Printer Used": the print window starts on the last printer used instead. */
  lastUsed: boolean
}

export interface Client {
  id: string
  workspaceId: string
  name: string
  hostname: string | null
  os: Os | null
  arch: string | null
  version: string | null
  online: boolean
  lastSeenAt: number | null
  settings: ClientSettings
  settingsUpdatedAt: number
  /** Null until the device reports it; versions before 0.1.3 never do. */
  systemPrinters: SystemPrinters | null
  createdAt: number
}

export interface EnrollmentToken {
  id: string
  label: string | null
  maxUses: number
  uses: number
  expiresAt: number
  createdAt: number
}

/** Returned once when an enrollment token is minted. */
export interface Enrollment {
  token: string
  expiresAt: number
  server: string
  commands: { unix: string; windows: string }
}

export interface Passkey {
  id: string
  name: string
  backedUp: boolean
  createdAt: number
  lastUsedAt: number | null
}

export type SsoProviderId = 'google' | 'oidc'

/** A Google or OIDC account connected to the user for sign-in. */
export interface Identity {
  provider: SsoProviderId
  providerName: string
  /** The provider-verified address, when it sent one. */
  email: string | null
  createdAt: number
}

/** `available` lists the sign-in providers this server has turned on. */
export interface IdentityList {
  identities: Identity[]
  available: { provider: SsoProviderId; providerName: string }[]
}

export interface SessionInfo {
  id: string
  current: boolean
  userAgent: string | null
  ip: string | null
  createdAt: number
  lastSeenAt: number
}

export interface ApiToken {
  id: string
  kind: 'pat' | 'oauth'
  name: string
  workspaceId: string | null
  scopes: string[]
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
}

export interface InstanceSettings {
  appName: string
  signup: 'invite' | 'open'
  sso: {
    google: { enabled: boolean; clientId: string | null; hasSecret: boolean }
    oidc: {
      enabled: boolean
      name: string | null
      issuer: string | null
      clientId: string | null
      hasSecret: boolean
    }
  }
  email: {
    provider: 'none' | 'resend' | 'cloudflare'
    from: string | null
    hasApiKey: boolean
    /** Resend inbound webhook signing secret (`whsec_…`) is set. */
    hasWebhookSecret: boolean
    inbound: 'none' | 'cloudflare' | 'resend'
    inboundDomain: string | null
  }
}

/** Public, unauthenticated view used by the SPA before login. */
export interface InstanceInfo {
  appName: string
  version: string
  setupRequired: boolean
  signup: 'invite' | 'open'
  sso: { id: 'google' | 'oidc'; name: string }[]
  emailEnabled: boolean
}

export interface AuditEntry {
  id: number
  workspaceId: string | null
  actorType: 'user' | 'token' | 'client' | 'email' | 'system'
  actorId: string | null
  actorName: string | null
  action: string
  target: string | null
  data: Record<string, unknown> | null
  createdAt: number
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}
