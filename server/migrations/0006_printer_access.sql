-- Printer access extension (docs/printer-access.md); empty and unused until a workspace turns it on.
-- One id column per subject kind, so removing a member, device, group or printer cascades to its rows.
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX groups_name ON groups(workspace_id, name COLLATE NOCASE);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  member_type TEXT NOT NULL CHECK (member_type IN ('user', 'client')),
  user_id TEXT,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, user_id) REFERENCES members(workspace_id, user_id) ON DELETE CASCADE,
  CHECK ((member_type = 'user') = (user_id IS NOT NULL) AND (member_type = 'client') = (client_id IS NOT NULL))
);
CREATE UNIQUE INDEX group_members_unique ON group_members(group_id, member_type, COALESCE(user_id, client_id));
CREATE INDEX group_members_user ON group_members(workspace_id, user_id);
CREATE INDEX group_members_client ON group_members(client_id);

CREATE TABLE printer_roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX printer_roles_name ON printer_roles(workspace_id, name COLLATE NOCASE);

-- A printer's own Everyone role; no row means the workspace default.
CREATE TABLE printer_everyone (
  printer_id TEXT PRIMARY KEY REFERENCES printers(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX printer_everyone_workspace ON printer_everyone(workspace_id);

-- printer_id NULL: the grant covers every printer in the workspace.
CREATE TABLE printer_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  printer_id TEXT REFERENCES printers(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('everyone', 'user', 'group', 'client')),
  user_id TEXT,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, user_id) REFERENCES members(workspace_id, user_id) ON DELETE CASCADE,
  CHECK ((subject_type = 'user') = (user_id IS NOT NULL) AND (subject_type = 'group') = (group_id IS NOT NULL)
     AND (subject_type = 'client') = (client_id IS NOT NULL))
);
-- One grant per subject and scope; COALESCE lets the NULLs (workspace-wide, Everyone) take part.
CREATE UNIQUE INDEX printer_grants_unique ON printer_grants(workspace_id, COALESCE(printer_id, ''), subject_type, COALESCE(user_id, group_id, client_id, ''));
CREATE INDEX printer_grants_printer ON printer_grants(printer_id);
CREATE INDEX printer_grants_user ON printer_grants(workspace_id, user_id);
CREATE INDEX printer_grants_group ON printer_grants(group_id);
CREATE INDEX printer_grants_client ON printer_grants(client_id);
