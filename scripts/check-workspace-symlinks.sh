#!/usr/bin/env bash
# check-workspace-symlinks.sh — read-only workspace symlink health check.
# Scans packages/*/node_modules and apps/*/node_modules for symlinks that are:
#   - broken (target does not exist), or
#   - absolute links pointing under /data/
# Anomalies -> exit 1.  Use --warn-only to print a summary and always exit 0.
# Read-only: this script never modifies anything.
set -u

WARN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --warn-only) WARN_ONLY=1 ;;
    *)
      echo "usage: $(basename "$0") [--warn-only]" >&2
      exit 2
      ;;
  esac
done

# repo root: prefer git, fall back to script location
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "${ROOT:-}" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$ROOT" || exit 2

broken=0
dataabs=0

emit() { printf '%s\n' "$1"; }
emit "=== check-workspace-symlinks === (warn-only=$WARN_ONLY)"
emit "root: $ROOT"

# Enumerate symlinks NUL-safely under workspace node_modules dirs.
link_count=0
while IFS= read -r -d '' link; do
  link_count=$((link_count + 1))
  raw="$(readlink "$link" 2>/dev/null || true)"
  resolved="$(readlink -f "$link" 2>/dev/null || true)"

  if [ -z "$resolved" ] || [ ! -e "$resolved" ]; then
    broken=$((broken + 1))
    emit "BROKEN: $link -> ${raw:-<unreadable>}"
  fi

  # absolute link under /data/ (string check on raw target and resolved path)
  # deliberately NOT skipped for broken links: a link can be both broken
  # and point at /data/ — count it in both categories for accurate triage.
  case "$raw" in
    /data/|/data/*)
      dataabs=$((dataabs + 1))
      emit "DATA-ABS: $link -> $raw"
      ;;
    *)
      case "$resolved" in
        /data/|/data/*)
          dataabs=$((dataabs + 1))
          emit "DATA-ABS: $link -> $raw (resolves to $resolved)"
          ;;
      esac
      ;;
  esac
done < <(find packages/*/node_modules apps/*/node_modules \
          -type l -print0 2>/dev/null)

emit "---"
emit "links scanned: $link_count"
emit "broken: $broken"
emit "abs-/data/: $dataabs"

if [ "$WARN_ONLY" -eq 1 ]; then
  emit "WARN_ONLY mode: anomalies above are informational; exit 0."
  exit 0
fi

if [ "$broken" -gt 0 ] || [ "$dataabs" -gt 0 ]; then
  emit "RESULT: FAIL (anomalies found)"
  exit 1
fi
emit "RESULT: OK"
exit 0
