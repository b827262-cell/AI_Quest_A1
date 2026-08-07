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
