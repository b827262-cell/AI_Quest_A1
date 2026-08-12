#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/opt/AI-Quest-A1}"

cd "$PROJECT_ROOT"
pnpm --filter AI-adm-D1 build
pnpm --filter AI-adm-D1 server:build

sudo mkdir -p /etc/ai-quest-a1 "$PROJECT_ROOT/data" "$PROJECT_ROOT/uploads"
if [ ! -f /etc/ai-quest-a1/admin.env ]; then
  sudo cp deploy/systemd/admin.env.example /etc/ai-quest-a1/admin.env
  sudo chmod 600 /etc/ai-quest-a1/admin.env
fi

sudo cp deploy/systemd/ai-adm-d1.service /etc/systemd/system/ai-adm-d1.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-adm-d1
sudo systemctl status ai-adm-d1 --no-pager

