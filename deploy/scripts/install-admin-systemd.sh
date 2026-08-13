#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/opt/AI-Quest-A1}"
ADMIN_ENV_FILE="/etc/ai-quest-a1/admin.env"

cd "$PROJECT_ROOT"
pnpm --filter AI-adm-D1 build
pnpm --filter AI-adm-D1 server:build

sudo mkdir -p "$(dirname "$ADMIN_ENV_FILE")" "$PROJECT_ROOT/data" "$PROJECT_ROOT/uploads"
if ! id -u ai-adm-d1 >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin ai-adm-d1
fi
sudo chown -R ai-adm-d1:ai-adm-d1 "$PROJECT_ROOT/data" "$PROJECT_ROOT/uploads"
if ! sudo test -f "$ADMIN_ENV_FILE"; then
  sudo cp deploy/systemd/admin.env.example "$ADMIN_ENV_FILE"
  sudo chmod 600 "$ADMIN_ENV_FILE"
  echo "Created production environment template at $ADMIN_ENV_FILE." >&2
  echo "Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH, AI_CREDENTIAL_ENCRYPTION_KEY, and GUEST_ASK_IP_HMAC_SECRET, then rerun this installer." >&2
  echo "The ai-adm-d1 service was not started." >&2
  exit 1
fi

required_env=(
  ADMIN_USERNAME
  ADMIN_PASSWORD_HASH
  AI_CREDENTIAL_ENCRYPTION_KEY
  GUEST_ASK_IP_HMAC_SECRET
)
missing_env=()
for name in "${required_env[@]}"; do
  if ! sudo awk -v required_name="$name" '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (index(line, required_name "=") != 1) next
      value = substr(line, length(required_name) + 2)
      sub(/^[[:space:]]*/, "", value)
      sub(/[[:space:]]*$/, "", value)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == sprintf("%c", 39) && substr(value, length(value), 1) == sprintf("%c", 39))) {
        value = length(value) == 2 ? "" : substr(value, 2, length(value) - 2)
      }
      found = length(value) > 0
    }
    END { exit found ? 0 : 1 }
  ' "$ADMIN_ENV_FILE"; then
    missing_env+=("$name")
  fi
done

if [ "${#missing_env[@]}" -gt 0 ]; then
  echo "Production environment is incomplete: ${missing_env[*]}." >&2
  echo "Update $ADMIN_ENV_FILE and rerun this installer." >&2
  echo "The ai-adm-d1 service was not started." >&2
  exit 1
fi

sudo cp deploy/systemd/ai-adm-d1.service /etc/systemd/system/ai-adm-d1.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-adm-d1
sudo systemctl status ai-adm-d1 --no-pager
