-- Print rules and limits (docs/print-policies.md); empty and unused until a workspace turns it on.
-- Conditions and actions are JSON (RuleConditions, RuleAction[]); ids inside them are checked when rules run.
CREATE TABLE print_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  exempt_admins INTEGER NOT NULL DEFAULT 0,
  -- Top to bottom; rewritten in full by PUT /policies/rules/order.
  position INTEGER NOT NULL,
  conditions TEXT NOT NULL DEFAULT '{}',
  actions TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX print_rules_workspace ON print_rules(workspace_id, position);

-- One id column per subject kind, so removing a member, group, device or printer removes its limits.
CREATE TABLE print_limits (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  exempt_admins INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL CHECK (scope IN ('each-member', 'member', 'group', 'group-each', 'each-device', 'device', 'printer', 'workspace')),
  user_id TEXT,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  printer_id TEXT REFERENCES printers(id) ON DELETE CASCADE,
  unit TEXT NOT NULL CHECK (unit IN ('pages', 'sheets', 'jobs', 'cost')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  -- JSON Cycle.
  cycle TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block', 'warn', 'approval')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, user_id) REFERENCES members(workspace_id, user_id) ON DELETE CASCADE,
  CHECK ((scope = 'member') = (user_id IS NOT NULL) AND (scope IN ('group', 'group-each')) = (group_id IS NOT NULL)
     AND (scope = 'device') = (client_id IS NOT NULL) AND (scope = 'printer') = (printer_id IS NOT NULL))
);
CREATE INDEX print_limits_workspace ON print_limits(workspace_id);
CREATE INDEX print_limits_user ON print_limits(workspace_id, user_id);
CREATE INDEX print_limits_group ON print_limits(group_id);
CREATE INDEX print_limits_client ON print_limits(client_id);
CREATE INDEX print_limits_printer ON print_limits(printer_id);

-- A one-off extra amount for one cycle; no member or device means the limit's shared count.
CREATE TABLE limit_adjustments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  limit_id TEXT NOT NULL REFERENCES print_limits(id) ON DELETE CASCADE,
  cycle_start INTEGER NOT NULL,
  user_id TEXT,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, user_id) REFERENCES members(workspace_id, user_id) ON DELETE CASCADE,
  CHECK (user_id IS NULL OR client_id IS NULL)
);
CREATE INDEX limit_adjustments_limit ON limit_adjustments(limit_id, cycle_start);
CREATE INDEX limit_adjustments_user ON limit_adjustments(workspace_id, user_id);
CREATE INDEX limit_adjustments_client ON limit_adjustments(client_id);
CREATE INDEX limit_adjustments_created_by ON limit_adjustments(created_by);
