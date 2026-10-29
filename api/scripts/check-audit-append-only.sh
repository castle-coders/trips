#!/bin/sh
# check-audit-append-only.sh
#
# Static guard for the append-only audit_events table (AUDIT_TDD 10, AUDIT_PRD
# 7 and acceptance criterion 9). The only legitimate writer is
# `db.insert(auditEvents)` in api/src/services/audit.ts; the test harness's
# resetStorage (api/test/helpers/) is the sole exception and is not scanned.
#
# Scans every .ts and .sql file under api/src and api/drizzle and fails
# (exit 1, one `file:line` per hit) on:
#   1. Drizzle `.update(auditEvents` or `.delete(auditEvents`, including the
#      form split across two lines (`.update(` at end of line, `auditEvents`
#      at the start of the next).
#   2. SQL `UPDATE audit_events`, `DELETE FROM audit_events`,
#      `DROP TABLE audit_events`, `TRUNCATE audit_events` (case-insensitive,
#      optional backtick or double-quote around the table name).
#   3. Any line outside api/src/db/schema.ts and api/src/services/audit.ts
#      that mentions `auditEvents` together with `.update(` or `.delete(`.
#
# Usage:
#   sh api/scripts/check-audit-append-only.sh            # from the repo root
#   sh scripts/check-audit-append-only.sh                # from api/
#   sh scripts/check-audit-append-only.sh FILE_OR_DIR... # scan these instead
#                                                        # (used to self-test)
#
# Known limitation: this is a textual check, not a parser. A comment that
# spells out the forbidden code shape (for example a code sample containing
# `db.delete(auditEvents)`) is reported the same as real code; reword the
# comment rather than widening the pattern. Calls split over three or more
# lines, or routed through an alias (`const t = auditEvents`), are not caught.
# Runs with the pool's own test suite as a second line of defence.

set -eu

script_dir=$(cd "$(dirname "$0")" && pwd)
api_dir=$(cd "$script_dir/.." && pwd)
repo_dir=$(cd "$api_dir/.." && pwd)

if [ "$#" -gt 0 ]; then
  targets="$*"
else
  targets="$api_dir/src $api_dir/drizzle"
fi

# Files allowed to reference auditEvents on the same line as .update(/.delete(
# (rule 3 only; rules 1 and 2 apply to every file).
exempt_rule3="src/db/schema.ts src/services/audit.ts"

# Prints `line<TAB>message` for each hit in the file given as $1.
# $2 is "1" when rule 3 is exempt for this file.
scan_file() {
  awk -v exempt="$2" '
    function report(msg) { printf "%d\t%s\n", NR, msg }
    {
      line = $0
      lower = tolower(line)
      ident = "auditEvents([^A-Za-z0-9_]|$)"
      table = "[`\"]?audit_events([^a-z0-9_]|$)"

      if (line ~ ("\\.(update|delete)[[:space:]]*\\([[:space:]]*" ident))
        report("Drizzle update/delete on auditEvents")
      else if (prev ~ /\.(update|delete)[[:space:]]*\([[:space:]]*$/ && line ~ ("^[[:space:]]*" ident))
        report("Drizzle update/delete on auditEvents (call split across lines)")
      else if (lower ~ ("update[[:space:]]+" table))
        report("SQL UPDATE audit_events")
      else if (lower ~ ("delete[[:space:]]+from[[:space:]]+" table))
        report("SQL DELETE FROM audit_events")
      else if (lower ~ ("drop[[:space:]]+table[[:space:]]+(if[[:space:]]+exists[[:space:]]+)?" table))
        report("SQL DROP TABLE audit_events")
      else if (lower ~ ("truncate[[:space:]]+(table[[:space:]]+)?" table))
        report("SQL TRUNCATE audit_events")
      else if (exempt != "1" && line ~ ident && line ~ /\.(update|delete)[[:space:]]*\(/)
        report("auditEvents on the same line as .update(/.delete( outside schema.ts and services/audit.ts")

      prev = line
    }
  ' "$1"
}

hits_file="${TMPDIR:-/tmp}/check-audit-append-only.$$"
trap 'rm -f "$hits_file"' EXIT
: > "$hits_file"

# shellcheck disable=SC2086  # $targets is intentionally word-split
for target in $targets; do
  if [ ! -e "$target" ]; then
    echo "check-audit-append-only: no such file or directory: $target" >&2
    exit 2
  fi
  find "$target" -type f \( -name '*.ts' -o -name '*.sql' \) | sort |
    while IFS= read -r file; do
      rel=${file#"$repo_dir/"}
      exempt=0
      for e in $exempt_rule3; do
        [ "$rel" = "api/$e" ] && exempt=1
      done
      scan_file "$file" "$exempt" | while IFS="$(printf '\t')" read -r lineno msg; do
        echo "$rel:$lineno: $msg"
        if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
          echo "::error file=$rel,line=$lineno::$msg"
        fi
      done
    done
done > "$hits_file"

# shellcheck disable=SC2086
scanned=$(for t in $targets; do find "$t" -type f \( -name '*.ts' -o -name '*.sql' \); done | wc -l | tr -d ' ')

if [ -s "$hits_file" ]; then
  cat "$hits_file" >&2
  fail=$(grep -c -v '^::error' "$hits_file" || true)
  echo "check-audit-append-only: FAIL ($fail hit(s); audit_events must be append-only, see api/src/services/audit.ts)" >&2
  exit 1
fi

echo "check-audit-append-only: OK ($scanned .ts/.sql files scanned, no UPDATE/DELETE against audit_events)"
