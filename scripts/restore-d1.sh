#!/usr/bin/env bash
# Loads a `wrangler d1 export` file into an empty D1 database, creating every table before any rows.
set -euo pipefail
. "$(dirname "$0")/lib/common.sh"

usage="usage: scripts/restore-d1.sh <export.sql> <database> (--local | --remote)"
[ $# -eq 3 ] || die "$usage"
src="$1" db="$2" where="$3"
case "$where" in --local | --remote) ;; *) die "$usage" ;; esac
[ -f "$src" ] || die "no such file: $src"
command -v sqlite3 >/dev/null || die "sqlite3 is required"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sqlite3 "$work/db" <"$src"
q() { sqlite3 "$work/db" "$1"; }
# Exports put each table's rows right after it, so a row can reference a table that doesn't exist yet.
{
  echo "PRAGMA defer_foreign_keys=TRUE;"
  q "SELECT sql || ';' FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
  q ".dump --data-only" | grep -v -e '^PRAGMA' -e '^BEGIN TRANSACTION' -e '^COMMIT' -e 'sqlite_sequence'
  q "SELECT sql || ';' FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL ORDER BY rowid"
} >"$work/restore.sql"

say "restoring $(q "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'") tables into $db ($where)"
cd "$SERVER_DIR"
pnpm exec wrangler d1 execute "$db" "$where" --file "$work/restore.sql"
