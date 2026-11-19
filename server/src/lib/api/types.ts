// Response shapes named in docs/api.md and docs/mcp.md but not exported from @shared.
import type { Job, Os, Role, User, WorkspaceSummary } from '@shared/types'

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface SessionState {
  user: User | null
  workspaces: WorkspaceSummary[]
}

export interface ChallengeOptions<T> {
  challengeId: string
  options: T
}

export interface InvitePreview {
  workspaceName: string
  inviterName: string | null
  role: Role
  expiresAt: number
}

export interface DeviceCodeInfo {
  hostname: string
  os: Os
  arch: string
  version: string
  expiresAt: number
  /** Only workspaces where the caller may approve (admin or owner). */
  workspaces: WorkspaceSummary[]
}

export interface CommandResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export interface DiagnoseCheck {
  name: string
  ok: boolean
  detail: string
}

export interface OAuthRequestInfo {
  client: { name: string; uri: string | null; logoUri: string | null }
  redirectHost: string
  scopes: string[]
  workspaces: WorkspaceSummary[]
}

export type DownloadKey =
  | 'macos-universal'
  | 'macos-pkg'
  | 'linux-x86_64'
  | 'linux-aarch64'
  | 'linux-armv7'
  | 'linux-armv6'
  | 'windows-x86_64'
  | 'windows-aarch64'

export interface DownloadManifest {
  version: string
  files: Partial<Record<DownloadKey, { name: string; sha256: string; size: number }>>
}

export interface JobFilters {
  printerId?: string
  status?: string
}

export interface CreatedUpload {
  job: Job
  uploadUrl: string
}
