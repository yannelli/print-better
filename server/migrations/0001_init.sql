-- Schema contract for phase 1. Times are Unix epoch ms; JSON columns hold camelCase objects
-- matching server/shared/*.ts. Secrets are stored only as SHA-256 hex hashes.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT UNIQUE COLLATE NOCASE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (user_id, code_hash)
);

-- Short-lived state: webauthn challenges, oidc state, oauth codes, reset links.
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX challenges_expiry ON challenges(expires_at);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  email TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at INTEGER
);
CREATE INDEX invites_workspace ON invites(workspace_id);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  hostname TEXT,
  os TEXT,
  arch TEXT,
  version TEXT,
  features TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  settings_updated_at INTEGER NOT NULL,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX clients_workspace ON clients(workspace_id);

CREATE TABLE enrollment_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX enrollment_workspace ON enrollment_tokens(workspace_id);

-- RFC 8628-style pairing for double-clicked installs. id = sha256(device_code).
CREATE TABLE device_codes (
  id TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  hostname TEXT,
  os TEXT,
  arch TEXT,
  version TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  client_name TEXT,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_poll_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE printers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  make_model TEXT,
  uuid TEXT,
  location TEXT,
  local INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  routes TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT '{"state":"unknown","reasons":[],"message":null,"supplies":[]}',
  defaults TEXT NOT NULL DEFAULT '{}',
  settings TEXT NOT NULL DEFAULT '{}',
  email_alias TEXT UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (client_id, key)
);
CREATE INDEX printers_workspace ON printers(workspace_id);
CREATE INDEX printers_uuid ON printers(workspace_id, uuid);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'api', 'mcp', 'email', 'lan', 'test')),
  title TEXT NOT NULL,
  file_key TEXT,
  file_name TEXT,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('uploading', 'queued', 'dispatched', 'printing', 'completed', 'failed', 'canceled')),
  status_message TEXT,
  pages INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX jobs_workspace_created ON jobs(workspace_id, created_at DESC);
CREATE INDEX jobs_printer_status ON jobs(printer_id, status);
CREATE INDEX jobs_status_completed ON jobs(status, completed_at);

-- Personal API tokens and OAuth access/refresh tokens (kind distinguishes them).
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pat', 'oauth-access', 'oauth-refresh')),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '["*"]',
  oauth_client_id TEXT REFERENCES oauth_clients(id) ON DELETE CASCADE,
  parent_id TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

-- Instance-wide settings (InstanceSettings fields); secrets inside are AES-GCM encrypted.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_workspace ON audit_log(workspace_id, created_at DESC);
