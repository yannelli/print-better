-- Shared by Print rules and limits and Enterprise controls (docs/usage.md); empty until one of them is on.
-- Money is in millionths of the workspace currency.
CREATE TABLE usage_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  bw_page_micros INTEGER NOT NULL DEFAULT 0 CHECK (bw_page_micros >= 0),
  color_page_micros INTEGER NOT NULL DEFAULT 0 CHECK (color_page_micros >= 0),
  duplex_sheet_discount_micros INTEGER NOT NULL DEFAULT 0 CHECK (duplex_sheet_discount_micros >= 0),
  updated_at INTEGER NOT NULL
);

-- A printer's own prices; no row means the workspace default.
CREATE TABLE printer_prices (
  printer_id TEXT PRIMARY KEY REFERENCES printers(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bw_page_micros INTEGER NOT NULL CHECK (bw_page_micros >= 0),
  color_page_micros INTEGER NOT NULL CHECK (color_page_micros >= 0),
  duplex_sheet_discount_micros INTEGER NOT NULL CHECK (duplex_sheet_discount_micros >= 0),
  updated_at INTEGER NOT NULL
);
CREATE INDEX printer_prices_workspace ON printer_prices(workspace_id);

-- One row per job attempt: the estimate while it waits or prints, what printed once it ends.
-- job_id has no foreign key: usage outlives deleted jobs, and rebuilding jobs never touches it.
CREATE TABLE usage_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  -- When the attempt was queued; it decides the cycle the usage counts in.
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
  cost_center_id TEXT,
  jobs INTEGER NOT NULL,
  pages INTEGER NOT NULL,
  sheets INTEGER NOT NULL,
  color_pages INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 1,
  settled_at INTEGER
);
CREATE UNIQUE INDEX usage_entries_attempt ON usage_entries(job_id, attempt);
-- Per-cycle sums by workspace, member, device, printer and cost center. Leading with the id also serves the foreign keys.
CREATE INDEX usage_entries_workspace ON usage_entries(workspace_id, at);
CREATE INDEX usage_entries_user ON usage_entries(user_id, at);
CREATE INDEX usage_entries_client ON usage_entries(client_id, at);
CREATE INDEX usage_entries_printer ON usage_entries(printer_id, at);
CREATE INDEX usage_entries_cost_center ON usage_entries(cost_center_id, at);
-- Rows still estimated, for the cron's settlement sweep.
CREATE INDEX usage_entries_open ON usage_entries(at) WHERE estimated = 1;
