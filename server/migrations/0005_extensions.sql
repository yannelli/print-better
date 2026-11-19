-- Optional modules (docs/extensions.md): each workspace's switch and settings per extension.
-- Instance availability is the settings row "extensions"; rows here stay while an extension is off.
CREATE TABLE workspace_extensions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, extension_id)
);
