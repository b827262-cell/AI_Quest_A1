# Admin authentication deployment contract

The Admin SPA uses one browser authentication flow in development, preview,
and production: `POST /api/admin/auth/login` creates a revocable server-side
session, and the browser sends only the `HttpOnly` session cookie plus the
non-HttpOnly CSRF cookie/header pair. The session cookie is `Secure` and
`SameSite=Strict`; production rejects plaintext password configuration.

## Production build and process

From the repository root:

```bash
pnpm --filter AI-adm-D1 build
pnpm --filter AI-adm-D1 server:build
```

Run `apps/AI-adm-D1/dist-server/admin-api.mjs` with
`deploy/systemd/ai-adm-d1.service`. The service must receive
`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECURE=true`,
`ADMIN_ALLOWED_ORIGINS`, `AI_CREDENTIAL_ENCRYPTION_KEY`, and `SQLITE_PATH`
through a protected environment file. Generate the hash without placing the
password in a command argument:

```bash
read -r -s ADMIN_PASSWORD_INPUT
printf '%s\n' "$ADMIN_PASSWORD_INPUT" | node --import ./apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs scripts/hash-admin-password.mjs
unset ADMIN_PASSWORD_INPUT
```

`ADMIN_API_TOKEN` is optional and exists only for CLI, internal services, and
automation that connect through a protected direct API path. It is never a
`VITE_*` variable and is never injected by Nginx or the SPA.

## Reverse proxy contract

Use `deploy/nginx/ai-admin-r1.conf` for the Admin origin. Production must not
run the Vite development proxy or `vite preview` as an API gateway. Nginx
serves the built SPA and proxies `/api/` to the loopback Admin API while
explicitly clearing `X-Admin-Token` and `Authorization`; browser requests
therefore cannot inherit a permanent management token. The proxy must run
behind HTTPS so the session cookie remains valid.

The browser origin must be listed in `ADMIN_ALLOWED_ORIGINS`. Unsafe session
requests also require the matching CSRF header, so a cross-origin page cannot
reuse the cookie for state changes.

## OIDC/SSO boundary

The current formal provider is the built-in username/password verifier backed
by the same server-side Session flow. If an OIDC/SSO provider is introduced,
it must terminate identity at the login boundary and issue this same app
session; it must not expose an OIDC access token or `ADMIN_API_TOKEN` to the
SPA. Do not replace the session cookie with a browser-readable bearer token.

## Audit and rotation

Successful and failed logins, logout, and every authenticated mutating Admin
request are written to `ai_admin_audit_logs`. Metadata is allowlisted and does
not include request bodies, API keys, cookies, or passwords. Revoke sessions
through the Admin session repository during incident response, then rotate
the optional CLI token separately.

