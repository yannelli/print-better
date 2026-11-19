// D1 row shapes for server/migrations/0001_init.sql (snake_case, JSON columns as text, booleans as 0/1).

export interface UserRow {
  id: string
  username: string
  email: string | null
  email_verified: number
  name: string
  password_hash: string | null
  is_admin: number
  created_at: number
  updated_at: number
}

export interface PasskeyRow {
  id: string
  user_id: string
  public_key: string
  alg: number
  sign_count: number
  transports: string | null
  backed_up: number
  name: string
  created_at: number
  last_used_at: number | null
}

export interface SessionRow {
  id: string
  user_id: string
  user_agent: string | null
  ip: string | null
  created_at: number
  last_seen_at: number
  expires_at: number
}

export interface ChallengeRow {
  id: string
  kind: string
  user_id: string | null
  data: string
  expires_at: number
}

export interface WorkspaceRow {
  id: string
  name: string
  settings: string
  created_at: number
}

export interface MemberRow {
  workspace_id: string
  user_id: string
  role: string
  created_at: number
}

export interface InviteRow {
  id: string
  workspace_id: string
  token_hash: string
  role: string
  email: string | null
  created_by: string | null
  created_at: number
  expires_at: number
  accepted_by: string | null
  accepted_at: number | null
}

export interface ClientRow {
  id: string
  workspace_id: string
  name: string
  token_hash: string
  hostname: string | null
  os: string | null
  arch: string | null
  version: string | null
  features: string
  settings: string
  settings_updated_at: number
  online: number
  last_seen_at: number | null
  /** JSON SystemPrinters, null until the device reports it. */
  system_printers: string | null
  created_at: number
}

export interface EnrollmentRow {
  id: string
  workspace_id: string
  token_hash: string
  label: string | null
  created_by: string | null
  max_uses: number
  uses: number
  expires_at: number
  created_at: number
}

export interface DeviceCodeRow {
  id: string
  user_code: string
  hostname: string | null
  os: string | null
  arch: string | null
  version: string | null
  status: 'pending' | 'approved' | 'denied' | 'consumed'
  workspace_id: string | null
  client_name: string | null
  approved_by: string | null
  last_poll_at: number | null
  expires_at: number
  created_at: number
}

export interface PrinterRow {
  id: string
  workspace_id: string
  client_id: string
  key: string
  name: string
  make_model: string | null
  uuid: string | null
  location: string | null
  local: number
  added: number
  routes: string
  capabilities: string
  status: string
  defaults: string
  settings: string
  email_alias: string | null
  created_at: number
  updated_at: number
}

/** Printer joined with its client's name and online flag. */
export interface PrinterViewRow extends PrinterRow {
  client_name: string
  client_online: number
}

export interface JobRow {
  id: string
  workspace_id: string
  printer_id: string | null
  user_id: string | null
  source: string
  title: string
  file_key: string | null
  file_name: string | null
  content_type: string
  size: number
  sha256: string | null
  options: string
  status: string
  status_message: string | null
  pages: number | null
  attempts: number
  created_at: number
  updated_at: number
  completed_at: number | null
  source_client_id: string | null
  requested_by: string | null
  /** JSON `JobPolicy`, `JobHold` and `JobUsage`; null until an extension sets them (docs/usage.md). */
  policy: string | null
  held: string | null
  usage: string | null
  cost_center_id: string | null
}

/** Job joined with its printer's name and, for device jobs, the submitting device's name. */
export interface JobViewRow extends JobRow {
  printer_name: string | null
  source_client_name: string | null
}

export interface ApiTokenRow {
  id: string
  user_id: string
  workspace_id: string | null
  kind: 'pat' | 'oauth-access' | 'oauth-refresh'
  name: string
  token_hash: string
  scopes: string
  oauth_client_id: string | null
  parent_id: string | null
  created_at: number
  last_used_at: number | null
  expires_at: number | null
  /** OAuth access tokens: the resource (audience) they were issued for. */
  resource: string | null
}

export interface AuditRow {
  id: number
  workspace_id: string | null
  actor_type: string
  actor_id: string | null
  actor_name: string | null
  action: string
  target: string | null
  data: string | null
  created_at: number
}
