# Deploy

AI-Stu-R1 1GB deployment uses:

- Nginx
- Node.js 22
- SQLite
- systemd

Do not use PM2, Docker, MySQL, Redis, Qdrant, Ollama, pnpm dev, PDF parse, or full RAG on the 1GB student machine.

## Admin production deployment

The Admin API and SPA are deployed separately from the Student 1GB node. Build
the static SPA and Node API bundle with:

```bash
pnpm --filter AI-adm-D1 build
pnpm --filter AI-adm-D1 server:build
```

Use `deploy/systemd/ai-adm-d1.service` and
`deploy/nginx/ai-admin-r1.conf`. Production does not use the Vite development
proxy. The browser authenticates with the revocable HttpOnly Session Cookie;
`ADMIN_API_TOKEN` is reserved for protected CLI/internal automation and must
not appear in `VITE_*`, the browser bundle, local/session storage, or an
unconditional reverse-proxy header. See
`docs/ADMIN_AUTH_DEPLOYMENT.md` for the environment and CSRF contract.

## B3 exam-course search API (port 4360)

`deploy/nginx/ai-stu-r1.conf` proxies `/api/public/exam-courses/` to
`127.0.0.1:4360`; start this sidecar before reloading nginx, or that route
returns 502.

By default it serves the validated 16-row B1 snapshot
(`B3_SEARCH_STORE=snapshot`, see `data/b3-ibrain-search-api/snapshot-store.mjs`),
so no PostgreSQL is needed. Setting a read-only `DATABASE_URL` in
`/etc/b3-search-api/search.env` switches it to the live B2 database.

Install or update, as root:

    deploy/scripts/install-b3-search.sh <repo-checkout> "$(command -v node)"

The script copies the needed files and its own node binary to
`/opt/b3-ibrain-search-api`, installs `deploy/systemd/b3-search-api.service`,
and restarts it. Check with
`curl -fsS "http://127.0.0.1:4360/api/public/exam-courses/search?q=test"`.

Public access goes through the existing token-managed Cloudflare Tunnel: add a
Public Hostname in Cloudflare Zero Trust (Networks -> Tunnels -> this tunnel)
pointing at `http://127.0.0.1:4360`. The endpoint is unauthenticated, so add a
Cloudflare rate-limiting rule for that hostname before announcing it. Search
depends on E500 staying online.
