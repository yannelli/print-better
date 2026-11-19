-- Enterprise controls (docs/enterprise.md); empty and unused until a workspace turns it on.
-- Settings live in workspace_extensions.config; held jobs are jobs.status 'held' with jobs.held.
CREATE TABLE cost_centers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX cost_centers_name ON cost_centers(workspace_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX cost_centers_code ON cost_centers(workspace_id, code COLLATE NOCASE) WHERE code IS NOT NULL;

-- A member's, group's or device's default cost center.
CREATE TABLE cost_center_defaults (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group', 'client')),
  user_id TEXT,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  cost_center_id TEXT NOT NULL REFERENCES cost_centers(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, user_id) REFERENCES members(workspace_id, user_id) ON DELETE CASCADE,
  CHECK ((subject_type = 'user') = (user_id IS NOT NULL) AND (subject_type = 'group') = (group_id IS NOT NULL)
     AND (subject_type = 'client') = (client_id IS NOT NULL))
);
CREATE UNIQUE INDEX cost_center_defaults_subject ON cost_center_defaults(workspace_id, subject_type, COALESCE(user_id, group_id, client_id));
CREATE INDEX cost_center_defaults_user ON cost_center_defaults(workspace_id, user_id);
CREATE INDEX cost_center_defaults_group ON cost_center_defaults(group_id);
CREATE INDEX cost_center_defaults_client ON cost_center_defaults(client_id);
CREATE INDEX cost_center_defaults_cost_center ON cost_center_defaults(cost_center_id);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cost_center_id TEXT NOT NULL REFERENCES cost_centers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  unit TEXT NOT NULL CHECK (unit IN ('pages', 'cost')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  -- JSON Cycle.
  cycle TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block', 'warn', 'approval')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX budgets_workspace ON budgets(workspace_id);
CREATE INDEX budgets_cost_center ON budgets(cost_center_id);

-- A printer's approval and secure release switches; no row means both off.
CREATE TABLE printer_controls (
  printer_id TEXT PRIMARY KEY REFERENCES printers(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  approval INTEGER NOT NULL DEFAULT 0,
  secure_release INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX printer_controls_workspace ON printer_controls(workspace_id);

-- Emailed reports. `origin` is where the schedule was made, for the links in each email.
CREATE TABLE report_schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('member', 'group', 'device', 'printer', 'cost-center', 'source')),
  -- JSON Cycle, week or month.
  cycle TEXT NOT NULL,
  -- JSON array of member ids.
  recipients TEXT NOT NULL DEFAULT '[]',
  origin TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX report_schedules_workspace ON report_schedules(workspace_id);
CREATE INDEX report_schedules_due ON report_schedules(next_run_at);
CREATE INDEX report_schedules_created_by ON report_schedules(created_by);

-- Alerts already sent, so each goes out once per limit or budget, count, cycle and threshold.
-- `subject` names the count: '' when shared, else 'user:<id>' or 'client:<id>'.
CREATE TABLE usage_alerts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  limit_id TEXT REFERENCES print_limits(id) ON DELETE CASCADE,
  budget_id TEXT REFERENCES budgets(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT '',
  cycle_start INTEGER NOT NULL,
  threshold INTEGER NOT NULL CHECK (threshold IN (80, 100)),
  sent_at INTEGER NOT NULL,
  CHECK ((limit_id IS NULL) <> (budget_id IS NULL))
);
CREATE UNIQUE INDEX usage_alerts_once ON usage_alerts(COALESCE(limit_id, budget_id), subject, cycle_start, threshold);
CREATE INDEX usage_alerts_workspace ON usage_alerts(workspace_id, cycle_start);
CREATE INDEX usage_alerts_limit ON usage_alerts(limit_id);
CREATE INDEX usage_alerts_budget ON usage_alerts(budget_id);
