# AI-Stu-R1 1GB systemd Deployment

The 1GB student host now runs only the static SPA. All student/admin API paths are proxied to the E500 central API via Nginx.

Verification note:
- Central API reachable at `http://100.76.46.86:4300`.
- Using `http://e500:4321` is optional only when DNS/hosts maps `e500` to `100.76.46.86`.

## Runtime direction (1GB production)

- `STU_RUNTIME_MODE=remote-api` only (no local `sqlite-api`).
- No local `student.db` sync, no local PDF file serving, no local sqlite API runtime.
- `/api/student/*`, `/api/appearance-settings`, `/api/uploads/*` are handled by Nginx proxy to E500.

Legacy/local mode note:
- `sqlite-api` with local `student.db` is kept for compatibility tests only and is deprecated for 1GB production.

## Build (on the build machine)

```bash
pnpm install
pnpm --filter AI-Stu-R1 build         # -> apps/AI-Stu-R1/dist (static SPA)
```

`pnpm --filter AI-Stu-R1 server:build` is optional and only needed if you also want a local fallback API.

## Provision the 1GB host

```bash
sudo mkdir -p /opt/AI-Stu-R1/dist
sudo mkdir -p /opt/AI-Stu-R1/dist-server  # optional, for local fallback API only
cd /opt/AI-Stu-R1
```

Ship only:
- `apps/AI-Stu-R1/dist/`
- optional `apps/AI-Stu-R1/dist-server/` (fallback only)

```bash
sudo bash deploy/scripts/install-student-systemd.sh
```

## Environment (`/etc/ai-stu-r1/student.env`)

```bash
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=128
STU_RUNTIME_MODE=remote-api
STU_REMOTE_API_BASE_URL=http://100.76.46.86:4300
STU_PUBLIC_DIR=/opt/AI-Stu-R1/dist
STU_READONLY_MODE=true
STU_CHAT_MODE=keyword
```

Do not set `STU_DB_PATH` in the 1GB production profile.

## systemd guard rails (`deploy/systemd/ai-stu-r1.service`)

Keep this service only if you intentionally keep a local stu-api fallback. Production static deployment does not need it for student API.

- `ExecStart=/usr/bin/node /opt/AI-Stu-R1/dist-server/stu-api.mjs`
- `EnvironmentFile=/etc/ai-stu-r1/student.env`
- `NODE_OPTIONS=--max-old-space-size=128`
- `MemoryHigh=200M`, `MemoryMax=256M`
- `Restart=always`

## Nginx (`deploy/nginx/ai-stu-r1.conf`)

- Serves `/opt/AI-Stu-R1/dist` as SPA.
- Proxies:
  - `/api/student/*` → `http://100.76.46.86:4300/api/student/*`
  - `/api/appearance-settings` → `http://100.76.46.86:4300/api/appearance-settings`
  - `/api/uploads/*` → `http://100.76.46.86:4300/api/uploads/*`
  - Explicitly deny `/uploads/books/*` (do not expose local PDFs directly).

## Scripts

- `deploy/scripts/install-student-systemd.sh` — install service files and (optional) enable stu-api service.
- `deploy/scripts/healthcheck-student.sh` — local script remains targeted at local API; update it for your deployment target if used.
