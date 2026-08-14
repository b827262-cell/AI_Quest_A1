#!/usr/bin/env bash
set -Eeuo pipefail

# AI-SmartBook 一鍵重啟腳本
#
# 用法：
#   chmod +x reset-ai-smartbook.sh
#   ./reset-ai-smartbook.sh            # 預設 restart
#   ./reset-ai-smartbook.sh start
#   ./reset-ai-smartbook.sh stop
#   ./reset-ai-smartbook.sh restart
#   ./reset-ai-smartbook.sh status
#   ./reset-ai-smartbook.sh logs
#   ./reset-ai-smartbook.sh init-token
#   ./reset-ai-smartbook.sh init-vault-key
#
# 可選環境變數：
#   PROJECT_ROOT=/path/to/AI-SmartBook-R1
#   START_TIMEOUT=45
#   ADMIN_API_CMD='pnpm --filter AI-adm-D1 server:dev'
#   ADMIN_WEB_CMD='pnpm --filter AI-adm-D1 dev'
#   STUDENT_API_CMD='pnpm --filter AI-Stu-R1 server:dev'
#   STUDENT_WEB_CMD='pnpm --filter AI-Stu-R1 dev'

ACTION="${1:-restart}"
START_TIMEOUT="${START_TIMEOUT:-45}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-}"

if [[ -z "$PROJECT_ROOT" ]]; then
  if [[ -f "$SCRIPT_DIR/package.json" ]]; then
    PROJECT_ROOT="$SCRIPT_DIR"
  elif git -C "$PWD" rev-parse --show-toplevel >/dev/null 2>&1; then
    PROJECT_ROOT="$(git -C "$PWD" rev-parse --show-toplevel)"
  else
    PROJECT_ROOT="$PWD"
  fi
fi

PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
RUN_DIR="$PROJECT_ROOT/.run/ai-smartbook"
LOG_DIR="$PROJECT_ROOT/logs/dev"

ADMIN_API_CMD="${ADMIN_API_CMD:-pnpm --filter AI-adm-D1 server:dev}"
ADMIN_WEB_CMD="${ADMIN_WEB_CMD:-pnpm --filter AI-adm-D1 dev}"
STUDENT_API_CMD="${STUDENT_API_CMD:-pnpm --filter AI-Stu-R1 server:dev}"
STUDENT_WEB_CMD="${STUDENT_WEB_CMD:-pnpm --filter AI-Stu-R1 dev}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

declare -A PORTS=(
  [admin-api]=4300
  [student-api]=4310
  [admin-web]=5174
  [student-web]=5173
)

declare -A COMMANDS=(
  [admin-api]="$ADMIN_API_CMD"
  [student-api]="$STUDENT_API_CMD"
  [admin-web]="$ADMIN_WEB_CMD"
  [student-web]="$STUDENT_WEB_CMD"
)

declare -A URLS=(
  [admin-api]="http://127.0.0.1:4300"
  [student-api]="http://127.0.0.1:4310"
  [admin-web]="http://127.0.0.1:5174"
  [student-web]="http://127.0.0.1:5173"
)

SERVICES=(admin-api student-api admin-web student-web)

say() {
  printf '\033[1;34m[AI-SmartBook]\033[0m %s\n' "$*"
}

ok() {
  printf '\033[1;32m[PASS]\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33m[WARN]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2
}

require_project() {
  if [[ ! -f "$PROJECT_ROOT/package.json" ]]; then
    fail "找不到 $PROJECT_ROOT/package.json"
    fail "請將腳本放在專案根目錄，或設定 PROJECT_ROOT。"
    exit 1
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    fail "找不到 pnpm，請先安裝並確認 PATH。"
    exit 1
  fi
}

ensure_admin_token() {
  if ! node "$PROJECT_ROOT/scripts/ensure-admin-token.mjs" --check; then
    fail "根目錄 .env 缺少 ADMIN_API_TOKEN；請先執行 ./reset-ai-smartbook.sh init-token。"
    exit 1
  fi
}

ensure_vault_key() {
  if ! node "$PROJECT_ROOT/scripts/ensure-vault-key.mjs" --check; then
    fail "根目錄 .env 缺少 AI_CREDENTIAL_ENCRYPTION_KEY；請先執行 ./reset-ai-smartbook.sh init-vault-key。"
    exit 1
  fi
}

is_pid_alive() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

is_port_open() {
  local port="$1"

  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q .
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi

  (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
}

read_admin_token() {
  if [[ -n "${ADMIN_API_TOKEN:-}" ]]; then
    printf '%s' "$ADMIN_API_TOKEN"
    return 0
  fi
  if [[ -f "$PROJECT_ROOT/.env" ]]; then
    awk -F= '/^[[:space:]]*(export[[:space:]]+)?ADMIN_API_TOKEN[[:space:]]*=/ {
      value=$0; sub(/^[^=]*=/, "", value); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value);
      if (value ~ /^".*"$/ || value ~ /^'"'"'.*'"'"'$/) value=substr(value, 2, length(value)-2);
      print value; exit
    }' "$PROJECT_ROOT/.env"
  fi
}

read_env_value() {
  local key="$1"
  local value=""
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return 0
  fi
  if [[ -f "$PROJECT_ROOT/.env" ]]; then
    value="$(awk -F= -v wanted_key="$key" '$1 ~ /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*$/ {
      name=$1; sub(/^[[:space:]]*(export[[:space:]]+)?/, "", name); gsub(/[[:space:]]+$/, "", name);
      if (name != wanted_key) next;
      result=$0; sub(/^[^=]*=/, "", result); gsub(/^[[:space:]]+|[[:space:]]+$/, "", result);
      if (result ~ /^".*"$/ || result ~ /^'"'"'.*'"'"'$/) result=substr(result, 2, length(result)-2);
      print result; exit
    }' "$PROJECT_ROOT/.env")"
  fi
  printf '%s' "$value"
}

http_status() {
  local url="$1"
  local token="${2:-}"
  if [[ -n "$token" ]]; then
    curl -sS --max-time 5 -o /dev/null -w '%{http_code}' -H "x-admin-token: $token" "$url" 2>/dev/null || printf '000'
  else
    curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || printf '000'
  fi
}

verify_admin_readiness() {
  local token live ready unauthenticated authenticated
  token="$(read_admin_token)"
  if [[ -z "$token" ]]; then
    fail "Admin readiness 無法驗證：ADMIN_API_TOKEN 無法讀取。"
    return 1
  fi

  live="$(http_status "${URLS[admin-api]}/health/live")"
  ready="$(http_status "${URLS[admin-api]}/health/ready")"
  unauthenticated="$(http_status "${URLS[admin-api]}/api/admin/accounts")"
  authenticated="$(http_status "${URLS[admin-api]}/api/admin/accounts" "$token")"

  if [[ "$live" != "200" || "$ready" != "200" || "$unauthenticated" != "401" || "$authenticated" != "200" ]]; then
    fail "Admin HTTP readiness 失敗：live=$live ready=$ready unauthenticated=$unauthenticated authenticated=$authenticated"
    return 1
  fi
  return 0
}

verify_admin_proxy() {
  local username password login_payload login_status proxy_status headers session_cookie csrf_cookie cookie_header
  username="$(read_env_value ADMIN_USERNAME)"
  password="$(read_env_value ADMIN_PASSWORD)"
  if [[ -z "$username" || -z "$password" ]]; then
    fail "Vite proxy readiness 無法驗證：ADMIN_USERNAME／ADMIN_PASSWORD 未設定。"
    return 1
  fi

  headers="$RUN_DIR/admin-proxy-headers.$$.tmp"
  rm -f "$headers"
  login_payload="$(ADMIN_LOGIN_USER="$username" ADMIN_LOGIN_PASSWORD="$password" node -e 'process.stdout.write(JSON.stringify({username: process.env.ADMIN_LOGIN_USER, password: process.env.ADMIN_LOGIN_PASSWORD}))')"
  if ! login_status="$(curl -sS --max-time 5 -D "$headers" -o /dev/null -w '%{http_code}' \
    -H 'Origin: http://127.0.0.1:5174' -H 'Content-Type: application/json' \
    --data-binary "$login_payload" "${URLS[admin-web]}/api/admin/auth/login")"; then
    login_status="000"
  fi
  session_cookie="$(sed -nE 's/^[Ss]et-[Cc]ookie:[[:space:]]*(ai_admin_session=[^;]+).*/\1/p' "$headers" | head -n 1)"
  csrf_cookie="$(sed -nE 's/^[Ss]et-[Cc]ookie:[[:space:]]*(ai_admin_csrf=[^;]+).*/\1/p' "$headers" | head -n 1)"
  cookie_header="$session_cookie; $csrf_cookie"
  if [[ "$login_status" == "200" && -n "$session_cookie" && -n "$csrf_cookie" ]]; then
    proxy_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
      -H "Cookie: $cookie_header" "${URLS[admin-web]}/api/admin/accounts" 2>/dev/null || printf '000')"
  else
    proxy_status="000"
  fi
  rm -f "$headers"
  if [[ "$proxy_status" != "200" ]]; then
    fail "Vite proxy readiness 失敗：login=$login_status status=$proxy_status"
    return 1
  fi
  return 0
}

kill_port() {
  local port="$1"

  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill -TERM $pids >/dev/null 2>&1 || true
      sleep 1
      # shellcheck disable=SC2086
      kill -KILL $pids >/dev/null 2>&1 || true
    fi
  fi
}

stop_service() {
  local service="$1"
  local pid_file="$RUN_DIR/$service.pid"
  local port="${PORTS[$service]}"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"

    if [[ "$pid" =~ ^[0-9]+$ ]] && is_pid_alive "$pid"; then
      say "停止 $service（PID $pid）"

      # 若由 setsid 啟動，優先終止整個 process group。
      kill -TERM -- "-$pid" >/dev/null 2>&1 || kill -TERM "$pid" >/dev/null 2>&1 || true

      for _ in {1..20}; do
        is_pid_alive "$pid" || break
        sleep 0.25
      done

      if is_pid_alive "$pid"; then
        kill -KILL -- "-$pid" >/dev/null 2>&1 || kill -KILL "$pid" >/dev/null 2>&1 || true
      fi
    fi

    rm -f "$pid_file"
  fi

  if is_port_open "$port"; then
    warn "$service 的連接埠 $port 仍被占用，執行連接埠清理。"
    kill_port "$port"
    sleep 1
  fi
}

stop_all() {
  say "停止 AI-SmartBook 前後台服務……"

  # 先停前端，再停 API。
  for service in student-web admin-web student-api admin-api; do
    stop_service "$service"
  done

  ok "全部服務已停止。"
}

start_service() {
  local service="$1"
  local port="${PORTS[$service]}"
  local command="${COMMANDS[$service]}"
  local log_file="$LOG_DIR/$service.log"
  local pid_file="$RUN_DIR/$service.pid"

  if is_port_open "$port"; then
    fail "$service 無法啟動：連接埠 $port 已被占用。"
    return 1
  fi

  : > "$log_file"
  say "啟動 $service：$command"

  if command -v setsid >/dev/null 2>&1; then
    (
      cd "$PROJECT_ROOT"
      nohup setsid bash -lc "exec $command" >>"$log_file" 2>&1 &
      echo "$!" >"$pid_file"
    )
  else
    (
      cd "$PROJECT_ROOT"
      nohup bash -lc "exec $command" >>"$log_file" 2>&1 &
      echo "$!" >"$pid_file"
    )
  fi

  local pid
  pid="$(cat "$pid_file")"

  for ((i = 1; i <= START_TIMEOUT; i++)); do
    if ! is_pid_alive "$pid"; then
      fail "$service 啟動程序已提前結束。"
      tail -n 40 "$log_file" >&2 || true
      return 1
    fi

    if is_port_open "$port"; then
      if [[ "$service" == "admin-api" ]] && ! verify_admin_readiness; then
        tail -n 40 "$log_file" >&2 || true
        return 1
      fi
      if [[ "$service" == "admin-web" ]] && ! verify_admin_proxy; then
        tail -n 40 "$log_file" >&2 || true
        return 1
      fi
      ok "$service 已啟動：${URLS[$service]}（PID $pid）"
      return 0
    fi

    sleep 1
  done

  fail "$service 在 ${START_TIMEOUT} 秒內未監聽連接埠 $port。"
  tail -n 40 "$log_file" >&2 || true
  return 1
}

start_all() {
  require_project
  ensure_admin_token
  ensure_vault_key
  say "專案根目錄：$PROJECT_ROOT"

  # API 先啟動，再啟動前端。
  for service in admin-api student-api admin-web student-web; do
    if ! start_service "$service"; then
      fail "啟動失敗，開始清理已啟動的服務。"
      stop_all
      exit 1
    fi
  done

  printf '\n'
  ok "AI-SmartBook 前後台全部啟動完成。"
  printf '%s\n' \
    "學生前台：${URLS[student-web]}" \
    "管理前台：${URLS[admin-web]}" \
    "管理 API：${URLS[admin-api]}" \
    "學生 API：${URLS[student-api]}" \
    "日誌目錄：$LOG_DIR"
}

show_status() {
  if node "$PROJECT_ROOT/scripts/ensure-admin-token.mjs" --check >/dev/null 2>&1; then
    say "ADMIN_API_TOKEN: configured"
  else
    warn "ADMIN_API_TOKEN: missing"
  fi
  if node "$PROJECT_ROOT/scripts/ensure-vault-key.mjs" --check >/dev/null 2>&1; then
    say "AI_CREDENTIAL_ENCRYPTION_KEY: configured"
  else
    warn "AI_CREDENTIAL_ENCRYPTION_KEY: missing"
  fi
  printf '%-14s %-8s %-8s %s\n' "SERVICE" "PORT" "STATUS" "URL"
  printf '%-14s %-8s %-8s %s\n' "--------------" "--------" "--------" "----------------------------"

  local service port status
  for service in "${SERVICES[@]}"; do
    port="${PORTS[$service]}"
    if is_port_open "$port"; then
      status="RUNNING"
    else
      status="STOPPED"
    fi
    printf '%-14s %-8s %-8s %s\n' "$service" "$port" "$status" "${URLS[$service]}"
  done
}

show_logs() {
  local files=()
  local service

  for service in "${SERVICES[@]}"; do
    files+=("$LOG_DIR/$service.log")
    touch "$LOG_DIR/$service.log"
  done

  say "按 Ctrl+C 離開日誌追蹤。"
  tail -n 80 -F "${files[@]}"
}

case "$ACTION" in
  start)
    start_all
    ;;
  stop)
    stop_all
    ;;
  restart|reset)
    require_project
    ensure_admin_token
    ensure_vault_key
    stop_all
    start_all
    ;;
  init-token)
    require_project
    node "$PROJECT_ROOT/scripts/ensure-admin-token.mjs" --init
    ;;
  init-vault-key)
    require_project
    node "$PROJECT_ROOT/scripts/ensure-vault-key.mjs" --init
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs
    ;;
  *)
    cat >&2 <<'USAGE'
用法：
  ./reset-ai-smartbook.sh [start|stop|restart|reset|status|logs|init-token|init-vault-key]

預設動作：
  restart

範例：
  ./reset-ai-smartbook.sh
  ./reset-ai-smartbook.sh status
  ./reset-ai-smartbook.sh logs
USAGE
    exit 64
    ;;
esac
