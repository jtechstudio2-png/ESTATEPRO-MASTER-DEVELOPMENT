#!/usr/bin/env bash
# Builds a fresh database from the migrations, then runs every test file.
# Usage: database/scripts/verify.sh [database_name]
# Requires: PostgreSQL 16+ client tools and a superuser connection (PG* env vars).
set -euo pipefail

DB="${1:-estatepro_verify}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -d "$DB")

dropdb --if-exists "$DB"
createdb "$DB"

for f in "$ROOT"/migrations/*.sql; do
  echo "migrate  $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done

for f in "$ROOT"/tests/*.sql; do
  echo "test     $(basename "$f")"
  "${PSQL[@]}" -o /dev/null -f "$f" 2>&1 | sed -n 's/.*NOTICE:  /  /p; /FAIL/p; /ERROR/p'
  [ "${PIPESTATUS[0]}" -eq 0 ] || { echo "FAILED: $(basename "$f")"; exit 1; }
done

echo "OK: $(ls "$ROOT"/migrations/*.sql | wc -l) migrations applied, $(ls "$ROOT"/tests/*.sql | wc -l) test files passed"
