-- Jobs printed from a paired desktop's system print dialog (docs/remote-printers.md).
-- SQLite cannot alter a CHECK constraint, so jobs is rebuilt; nothing references jobs.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'api', 'mcp', 'email', 'lan', 'test', 'device')),
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
  completed_at INTEGER,
  source_client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  requested_by TEXT
);

INSERT INTO jobs_new (id, workspace_id, printer_id, user_id, source, title, file_key, file_name, content_type, size, sha256, options,
                      status, status_message, pages, attempts, created_at, updated_at, completed_at)
SELECT id, workspace_id, printer_id, user_id, source, title, file_key, file_name, content_type, size, sha256, options,
       status, status_message, pages, attempts, created_at, updated_at, completed_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX jobs_workspace_created ON jobs(workspace_id, created_at DESC);
CREATE INDEX jobs_printer_status ON jobs(printer_id, status);
CREATE INDEX jobs_status_completed ON jobs(status, completed_at);
-- Lets ON DELETE SET NULL find a removed device's jobs without a full scan.
CREATE INDEX jobs_source_client ON jobs(source_client_id);
