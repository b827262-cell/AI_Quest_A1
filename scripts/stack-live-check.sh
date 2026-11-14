#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only post-restart health & Vite proxy verification script for AI-SmartBook.
# Companion to ./reset-ai-smartbook.sh restart (never starts or stops services).

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

ADMIN_API_URL="${ADMIN_API_URL:-http://127.0.0.1:4300}"
STUDENT_API_URL="${STUDENT_API_URL:-http://127.0.0.1:4310}"
STUDENT_WEB_URL="${STUDENT_WEB_URL:-http://127.0.0.1:5173}"
ADMIN_WEB_URL="${ADMIN_WEB_URL:-http://127.0.0.1:5174}"

RUN_ID="LIVE-$(date +%Y%m%d-%H%M%S)"
JSON_PATH=""
NOTIFY_SLACK=0

usage() {
  cat <<'EOF'
Usage: scripts/stack-live-check.sh [OPTIONS]

Read-only post-restart health and Vite proxy check for the 4 AI-SmartBook services.

Options:
  --run-id <id>     Run identifier for output/JSON/RESULT line (default: LIVE-YYYYMMDD-HHMMSS)
  --json <path>     Write structured JSON summary to <path>
  --notify-slack    Send summary via scripts/slack-notify.ts (warns instead of failing if unconfigured)
  -h, --help        Show this help message and exit

Environment overrides:
  ADMIN_API_URL     Default: http://127.0.0.1:4300
  STUDENT_API_URL   Default: http://127.0.0.1:4310
  STUDENT_WEB_URL   Default: http://127.0.0.1:5173
  ADMIN_WEB_URL     Default: http://127.0.0.1:5174
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --run-id)
      if [[ $# -lt 2 || -z "$2" ]]; then
        printf '[FAIL] --run-id requires a non-empty value\n' >&2
        exit 2
      fi
      RUN_ID="$2"
      shift 2
      ;;
    --run-id=*)
      RUN_ID="${1#*=}"
      if [[ -z "$RUN_ID" ]]; then
        printf '[FAIL] --run-id requires a non-empty value\n' >&2
        exit 2
      fi
      shift
      ;;
    --json)
      if [[ $# -lt 2 || -z "$2" ]]; then
        printf '[FAIL] --json requires a file path\n' >&2
        exit 2
      fi
      JSON_PATH="$2"
      shift 2
      ;;
    --json=*)
      JSON_PATH="${1#*=}"
      if [[ -z "$JSON_PATH" ]]; then
        printf '[FAIL] --json requires a file path\n' >&2
        exit 2
      fi
      shift
      ;;
    --notify-slack)
      NOTIFY_SLACK=1
      shift
      ;;
    --)
      # pnpm v9 forwards a literal `--` when invoking package scripts as `pnpm run ... -- --flag`
      shift
      ;;
    *)
      printf '[FAIL] Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ADMIN_API_URL="${ADMIN_API_URL%/}"
STUDENT_API_URL="${STUDENT_API_URL%/}"
STUDENT_WEB_URL="${STUDENT_WEB_URL%/}"
ADMIN_WEB_URL="${ADMIN_WEB_URL%/}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CHECKS_TSV="$TMP_DIR/checks.tsv"
: > "$CHECKS_TSV"

declare -A SVC_STATUS=(
  [4300]="OK"
  [4310]="OK"
  [5173]="OK"
  [5174]="OK"
)

record_check() {
  local svc="$1"
  local name="$2"
  local path="$3"
  local url="$4"
  local expected_status="$5"
  local actual_status="$6"
  local expected_kind="$7"
  local passed="$8"
  local detail="$9"

  # Strip tabs/newlines so TSV remains single-line per record
  detail="${detail//$'\t'/ }"
  detail="${detail//$'\n'/ }"
  detail="${detail//$'\r'/ }"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$svc" "$name" "$path" "$url" "$expected_status" "$actual_status" "$expected_kind" "$passed" "$detail" >> "$CHECKS_TSV"
}

probe_check() {
  local svc="$1"
  local name="$2"
  local base_url="$3"
  local path="$4"
  local expected_status="$5"
  local expected_kind="$6"
  local required_substring="${7:-}"

  local url="${base_url}${path}"
  local hdr_file="$TMP_DIR/headers.tmp"
  local body_file="$TMP_DIR/body.tmp"
  local err_file="$TMP_DIR/curl.err"
  local status=""
  local curl_rc=0

  rm -f "$hdr_file" "$body_file" "$err_file"
  status="$(curl -sS --max-time 5 -D "$hdr_file" -o "$body_file" -w '%{http_code}' "$url" 2>"$err_file")" || curl_rc=$?
  status="${status:-000}"

  local content_type=""
  if [[ -f "$hdr_file" ]]; then
    content_type="$(grep -i '^content-type:' "$hdr_file" 2>/dev/null | tail -n 1 | sed -E 's/^[^:]+:[[:space:]]*//; s/\r$//' | tr '[:upper:]' '[:lower:]' || true)"
  fi

  local fail_reason=""
  if [[ "$curl_rc" -ne 0 && "$status" == "000" ]]; then
    local curl_msg=""
    if [[ -s "$err_file" ]]; then
      curl_msg="$(head -n 1 "$err_file")"
    fi
    fail_reason="request error (curl exit $curl_rc${curl_msg:+: $curl_msg})"
  elif [[ "$status" != "$expected_status" ]]; then
    fail_reason="expected HTTP $expected_status, got HTTP $status"
  elif [[ "$expected_kind" == "json" ]]; then
    if [[ "$content_type" != *"application/json"* ]]; then
      fail_reason="expected application/json content-type, got '${content_type:-none}'"
    elif ! node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$body_file" >/dev/null 2>&1; then
      fail_reason="invalid JSON response body"
    fi
  elif [[ "$expected_kind" == "html" ]]; then
    if [[ "$content_type" != *"text/html"* ]]; then
      fail_reason="expected text/html content-type, got '${content_type:-none}'"
    elif ! grep -qiE '<html|<div[[:space:]]+id=["'\'']root["'\'']' "$body_file" 2>/dev/null; then
      fail_reason="HTML body missing '<html' or '<div id=\"root\"'"
    fi
  fi

  if [[ -z "$fail_reason" && -n "$required_substring" ]]; then
    if ! grep -Fq "$required_substring" "$body_file" 2>/dev/null; then
      fail_reason="response body missing expected text '$required_substring'"
    fi
  fi

  if [[ -z "$fail_reason" ]]; then
    if [[ "$expected_kind" == "any" ]]; then
      printf '[PASS] [%s:%s] %s -> HTTP %s\n' "$svc" "$name" "$url" "$status"
    else
      printf '[PASS] [%s:%s] %s -> HTTP %s (%s)\n' "$svc" "$name" "$url" "$status" "$expected_kind"
    fi
    record_check "$svc" "$name" "$path" "$url" "$expected_status" "$status" "$expected_kind" "true" "OK"
  else
    SVC_STATUS["$svc"]="FAIL"
    printf '[FAIL] [%s:%s] %s -> %s\n' "$svc" "$name" "$url" "$fail_reason"
    record_check "$svc" "$name" "$path" "$url" "$expected_status" "$status" "$expected_kind" "false" "$fail_reason"
  fi
}

printf 'Running live stack check (run-id: %s)\n' "$RUN_ID"

# 4300 (admin-api)
probe_check "4300" "admin-api" "$ADMIN_API_URL" "/health/live" "200" "any"
probe_check "4300" "admin-api" "$ADMIN_API_URL" "/health/ready" "200" "any"

# 4310 (student-api)
probe_check "4310" "student-api" "$STUDENT_API_URL" "/health/live" "200" "any"
probe_check "4310" "student-api" "$STUDENT_API_URL" "/health/ready" "200" "any"
probe_check "4310" "student-api" "$STUDENT_API_URL" "/api/appearance-settings" "200" "json"

# 5173 (student-web)
probe_check "5173" "student-web" "$STUDENT_WEB_URL" "/" "200" "html"
probe_check "5173" "student-web" "$STUDENT_WEB_URL" "/api/student/books" "401" "json"
probe_check "5173" "student-web" "$STUDENT_WEB_URL" "/api/public/site-config" "200" "json"

# 5174 (admin-web)
probe_check "5174" "admin-web" "$ADMIN_WEB_URL" "/" "200" "html"
probe_check "5174" "admin-web" "$ADMIN_WEB_URL" "/api/admin/auth/me" "401" "json" "admin authentication required"

OVERALL_STATUS="OK"
EXIT_CODE=0
for svc in 4300 4310 5173 5174; do
  if [[ "${SVC_STATUS[$svc]}" != "OK" ]]; then
    OVERALL_STATUS="FAIL"
    EXIT_CODE=1
    break
  fi
done

RESULT_LINE="RESULT | ${RUN_ID} | - | 4300=${SVC_STATUS[4300]},4310=${SVC_STATUS[4310]},5173=${SVC_STATUS[5173]},5174=${SVC_STATUS[5174]}"

if [[ -n "$JSON_PATH" ]]; then
  mkdir -p "$(dirname -- "$JSON_PATH")"
  RUN_ID_ENV="$RUN_ID" \
  OVERALL_ENV="$OVERALL_STATUS" \
  RESULT_LINE_ENV="$RESULT_LINE" \
  ADMIN_API_URL_ENV="$ADMIN_API_URL" \
  STUDENT_API_URL_ENV="$STUDENT_API_URL" \
  STUDENT_WEB_URL_ENV="$STUDENT_WEB_URL" \
  ADMIN_WEB_URL_ENV="$ADMIN_WEB_URL" \
  S4300_ENV="${SVC_STATUS[4300]}" \
  S4310_ENV="${SVC_STATUS[4310]}" \
  S5173_ENV="${SVC_STATUS[5173]}" \
  S5174_ENV="${SVC_STATUS[5174]}" \
  node -e '
    const fs = require("node:fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter(Boolean);
    const checks = lines.map((line) => {
      const [service, name, path, url, expectedStatus, actualStatus, expectedKind, passed, detail] = line.split("\t");
      return {
        service,
        name,
        path,
        url,
        expectedStatus: Number(expectedStatus),
        actualStatus: Number(actualStatus),
        expectedKind,
        passed: passed === "true",
        detail
      };
    });
    const summary = {
      runId: process.env.RUN_ID_ENV,
      timestamp: new Date().toISOString(),
      overall: process.env.OVERALL_ENV,
      resultLine: process.env.RESULT_LINE_ENV,
      services: {
        "4300": { name: "admin-api", baseUrl: process.env.ADMIN_API_URL_ENV, status: process.env.S4300_ENV },
        "4310": { name: "student-api", baseUrl: process.env.STUDENT_API_URL_ENV, status: process.env.S4310_ENV },
        "5173": { name: "student-web", baseUrl: process.env.STUDENT_WEB_URL_ENV, status: process.env.S5173_ENV },
        "5174": { name: "admin-web", baseUrl: process.env.ADMIN_WEB_URL_ENV, status: process.env.S5174_ENV }
      },
      checks
    };
    fs.writeFileSync(process.argv[2], JSON.stringify(summary, null, 2) + "\n", "utf8");
  ' "$CHECKS_TSV" "$JSON_PATH"
  printf '[INFO] JSON summary written to %s\n' "$JSON_PATH"
fi

if [[ "$NOTIFY_SLACK" -eq 1 ]]; then
  SLACK_TSX_LOADER="$PROJECT_ROOT/apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs"
  SLACK_NOTIFY_SCRIPT="$PROJECT_ROOT/scripts/slack-notify.ts"
  if [[ ! -f "$SLACK_TSX_LOADER" || ! -f "$SLACK_NOTIFY_SCRIPT" ]]; then
    printf '[WARN] Slack notification skipped: missing slack-notify.ts or tsx loader\n' >&2
  else
    SLACK_LEVEL="error"
    if [[ "$OVERALL_STATUS" == "OK" ]]; then
      SLACK_LEVEL="success"
    fi
    (
      cd "$PROJECT_ROOT" && \
      SLACK_TITLE="AI-SmartBook Live Stack Check (${OVERALL_STATUS})" \
      SLACK_TEXT="$RESULT_LINE" \
      SLACK_LEVEL="$SLACK_LEVEL" \
      node --import ./apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs --input-type=module -e '
        import { sendSlackMessage } from "./scripts/slack-notify.ts";
        const level = process.env.SLACK_LEVEL === "success" ? "success" : "error";
        const res = await sendSlackMessage({
          title: process.env.SLACK_TITLE,
          text: process.env.SLACK_TEXT ?? "",
          level
        });
        if (!res.success) {
          console.warn(`[WARN] Slack notification not sent: ${res.error ?? "unknown error"}`);
        } else {
          console.log(`[PASS] Slack notification sent via ${res.mode}`);
        }
      '
    ) || printf '[WARN] Slack notification failed (continuing)\n' >&2
  fi
fi

printf '%s\n' "$RESULT_LINE"
exit "$EXIT_CODE"
