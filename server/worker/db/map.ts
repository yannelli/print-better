import type { Capabilities, Job, JobOptions, JobSource, JobStatus, Printer, PrinterStatus, Route } from '../../shared/printing'
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_PRINTER_SETTINGS,
  DEFAULT_WORKSPACE_SETTINGS,
  type ApiToken,
  type AuditEntry,
  type Client,
  type ClientSettings,
  type EnrollmentToken,
  type Invite,
  type Member,
  type Os,
  type Passkey,
  type PrinterSettings,
  type Role,
  type SessionInfo,
  type User,
  type Workspace,
  type WorkspaceSettings,
} from '../../shared/types'
import { parseJson } from '../lib/db'
import type {
  ApiTokenRow,
  AuditRow,
  ClientRow,
  EnrollmentRow,
  InviteRow,
  JobViewRow,
  PasskeyRow,
  PrinterViewRow,
  SessionRow,
  UserRow,
  WorkspaceRow,
} from './rows'

export const PRINTER_VIEW =
  'SELECT p.*, c.name AS client_name, c.online AS client_online FROM printers p JOIN clients c ON c.id = p.client_id'
/** Selected wherever a `jobs j` row becomes a `JobViewRow`. */
export const SOURCE_CLIENT_NAME = '(SELECT name FROM clients WHERE id = j.source_client_id) AS source_client_name'
export const JOB_VIEW = `SELECT j.*, p.name AS printer_name, ${SOURCE_CLIENT_NAME} FROM jobs j LEFT JOIN printers p ON p.id = j.printer_id`

export const EMPTY_CAPABILITIES: Capabilities = {
  formats: [],
  color: false,
  duplex: false,
  media: [],
  mediaDefault: null,
  resolutions: [],
  copiesMax: 1,
}
export const UNKNOWN_STATUS: PrinterStatus = { state: 'unknown', reasons: [], message: null, supplies: [] }

export const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  name: r.name,
  email: r.email,
  emailVerified: r.email_verified === 1,
  isAdmin: r.is_admin === 1,
  hasPassword: r.password_hash !== null,
  createdAt: r.created_at,
})

export function workspaceSettings(raw: string): WorkspaceSettings {
  const s = parseJson<Partial<WorkspaceSettings>>(raw, {})
  return {
    ...DEFAULT_WORKSPACE_SETTINGS,
    ...s,
    emailToPrint: { ...DEFAULT_WORKSPACE_SETTINGS.emailToPrint, ...s.emailToPrint },
  }
}

export const toWorkspace = (r: WorkspaceRow, role: Role): Workspace => ({
  id: r.id,
  name: r.name,
  role,
  settings: workspaceSettings(r.settings),
  createdAt: r.created_at,
})

export const toMember = (r: { user_id: string; username: string; name: string; email: string | null; role: string; created_at: number }): Member => ({
  userId: r.user_id,
  username: r.username,
  name: r.name,
  email: r.email,
  role: r.role as Role,
  createdAt: r.created_at,
})

export const toInvite = (r: InviteRow): Invite => ({
  id: r.id,
  role: r.role as Role,
  email: r.email,
  createdBy: r.created_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
})

export function clientSettings(raw: string): ClientSettings {
  const s = parseJson<Partial<ClientSettings>>(raw, {})
  return { ...DEFAULT_CLIENT_SETTINGS, ...s, discovery: { ...DEFAULT_CLIENT_SETTINGS.discovery, ...s.discovery } }
}

export const toClient = (r: ClientRow): Client => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  hostname: r.hostname,
  os: r.os as Os | null,
  arch: r.arch,
  version: r.version,
  online: r.online === 1,
  lastSeenAt: r.last_seen_at,
  settings: clientSettings(r.settings),
  settingsUpdatedAt: r.settings_updated_at,
  createdAt: r.created_at,
})

export const toEnrollment = (r: EnrollmentRow): EnrollmentToken => ({
  id: r.id,
  label: r.label,
  maxUses: r.max_uses,
  uses: r.uses,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
})

export const toPasskey = (r: PasskeyRow): Passkey => ({
  id: r.id,
  name: r.name,
  backedUp: r.backed_up === 1,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
})

export const toSession = (r: SessionRow, currentId: string | null): SessionInfo => ({
  id: r.id,
  current: r.id === currentId,
  userAgent: r.user_agent,
  ip: r.ip,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
})

export const toApiToken = (r: ApiTokenRow): ApiToken => ({
  id: r.id,
  kind: r.kind === 'pat' ? 'pat' : 'oauth',
  name: r.name,
  workspaceId: r.workspace_id,
  scopes: parseJson<string[]>(r.scopes, []),
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
})

export function printerSettings(raw: string): PrinterSettings {
  const s = parseJson<Partial<PrinterSettings>>(raw, {})
  return { ...DEFAULT_PRINTER_SETTINGS, ...s, email: { ...DEFAULT_PRINTER_SETTINGS.email, ...s.email } }
}

export const toPrinter = (r: PrinterViewRow): Printer => ({
  id: r.id,
  workspaceId: r.workspace_id,
  clientId: r.client_id,
  clientName: r.client_name,
  clientOnline: r.client_online === 1,
  key: r.key,
  name: r.name,
  makeModel: r.make_model,
  uuid: r.uuid,
  location: r.location,
  local: r.local === 1,
  routes: parseJson<Route[]>(r.routes, []),
  capabilities: { ...EMPTY_CAPABILITIES, ...parseJson<Partial<Capabilities>>(r.capabilities, {}) },
  status: { ...UNKNOWN_STATUS, ...parseJson<Partial<PrinterStatus>>(r.status, {}) },
  added: r.added === 1,
  defaults: parseJson<JobOptions>(r.defaults, {}),
  settings: printerSettings(r.settings),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export const toJob = (r: JobViewRow): Job => ({
  id: r.id,
  workspaceId: r.workspace_id,
  printerId: r.printer_id,
  printerName: r.printer_name,
  userId: r.user_id,
  source: r.source as JobSource,
  title: r.title,
  fileName: r.file_name,
  contentType: r.content_type,
  size: r.size,
  options: parseJson<JobOptions>(r.options, {}),
  status: r.status as JobStatus,
  statusMessage: r.status_message,
  pages: r.pages,
  attempts: r.attempts,
  hasFile: r.file_key !== null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
  sourceClientId: r.source_client_id,
  sourceClientName: r.source_client_name,
  requestedBy: r.requested_by,
})

export const toAudit = (r: AuditRow): AuditEntry => ({
  id: r.id,
  workspaceId: r.workspace_id,
  actorType: r.actor_type as AuditEntry['actorType'],
  actorId: r.actor_id,
  actorName: r.actor_name,
  action: r.action,
  target: r.target,
  data: parseJson<Record<string, unknown> | null>(r.data, null),
  createdAt: r.created_at,
})
