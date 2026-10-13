#!/usr/bin/env bash
# Install the B3 exam-course search sidecar (snapshot mode) as a systemd
# service on 127.0.0.1:4360. Run as root:
#   install-b3-search.sh <repo-checkout-dir> <path-to-node-binary>
# Idempotent: re-running refreshes the files and restarts the service.
set -euo pipefail

REPO="${1:?usage: install-b3-search.sh <repo-dir> <node-binary>}"
NODE_BIN="${2:?usage: install-b3-search.sh <repo-dir> <node-binary>}"
DEST=/opt/b3-ibrain-search-api
ETC=/etc/b3-search-api

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[ -x "$NODE_BIN" ] || { echo "node binary not executable: $NODE_BIN" >&2; exit 1; }

install -d -m 755 "$DEST/bin" "$DEST/data/b3-ibrain-search-api" "$DEST/data/b2-ibrain-postgresql" "$DEST/data/b1-ibrain-public" "$ETC"
# Own copy of node: the unit uses ProtectHome=yes, so an nvm node under /home is not reachable.
install -m 755 "$NODE_BIN" "$DEST/bin/node"
install -m 644 "$REPO"/data/b3-ibrain-search-api/{search-server,search-core,postgres-store,snapshot-store,public-source-url}.mjs "$DEST/data/b3-ibrain-search-api/"
install -m 644 "$REPO/data/b2-ibrain-postgresql/validate-snapshot.mjs" "$DEST/data/b2-ibrain-postgresql/"
install -m 644 "$REPO"/data/b1-ibrain-public/{raw-snapshot,crawl-manifest}.json "$DEST/data/b1-ibrain-public/"
[ -f "$ETC/search.env" ] || install -m 600 "$REPO/deploy/systemd/b3-search.env.example" "$ETC/search.env"
install -m 644 "$REPO/deploy/systemd/b3-search-api.service" /etc/systemd/system/b3-search-api.service

systemctl daemon-reload
systemctl enable b3-search-api >/dev/null
systemctl restart b3-search-api
sleep 2
systemctl is-active b3-search-api
