-- Print rules and limits, Enterprise controls (docs/usage.md): status `held` and what the job check recorded.
-- SQLite cannot alter a CHECK constraint, so jobs is rebuilt. Nothing references jobs; keep it that way.
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
  status TEXT NOT NULL CHECK (status IN ('uploading', 'held', 'queued', 'dispatched', 'printing', 'completed', 'failed', 'canceled')),
  status_message TEXT,
  pages INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  source_client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  requested_by TEXT,
  -- JSON JobPolicy, JobHold and JobUsage. NULL until an extension sets them, so Job JSON stays unchanged.
  policy TEXT,
  held TEXT,
  usage TEXT,
  -- No foreign key (cost_centers comes later); Enterprise controls deletes a cost center only while unused.
  cost_center_id TEXT
);

INSERT INTO jobs_new (id, workspace_id, printer_id, user_id, source, title, file_key, file_name, content_type, size, sha256, options,
                      status, status_message, pages, attempts, created_at, updated_at, completed_at, source_client_id, requested_by)
SELECT id, workspace_id, printer_id, user_id, source, title, file_key, file_name, content_type, size, sha256, options,
       status, status_message, pages, attempts, created_at, updated_at, completed_at, source_client_id, requested_by
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX jobs_workspace_created ON jobs(workspace_id, created_at DESC);
CREATE INDEX jobs_printer_status ON jobs(printer_id, status);
CREATE INDEX jobs_status_completed ON jobs(status, completed_at);
CREATE INDEX jobs_source_client ON jobs(source_client_id);
CREATE INDEX jobs_cost_center ON jobs(cost_center_id) WHERE cost_center_id IS NOT NULL;
