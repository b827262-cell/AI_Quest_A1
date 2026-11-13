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
`deploy/systemd/ai-adm-d1.service`. The service runs as the dedicated
non-root `ai-adm-d1` account and must receive
`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECURE=true`,
`ADMIN_ALLOWED_ORIGINS`, `AI_CREDENTIAL_ENCRYPTION_KEY`,
`GUEST_ASK_IP_HMAC_SECRET`, and `SQLITE_PATH`
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

### Client IP trust and nginx topologies

The admin and student APIs accept `CF-Connecting-IP` only from a loopback
socket. The nginx example overwrites that header with nginx's `$remote_addr`,
so its real-IP configuration and network access controls are part of the
security boundary. Verify the resulting client address before exposing traffic.

- **Cloudflare Tunnel:** the example trusts only loopback as the Tunnel source
  and uses `CF-Connecting-IP` to restore the visitor address. Keep the Tunnel
  listener private and ensure untrusted local processes cannot reach it.
- **Cloudflare orange-cloud proxy:** replace the loopback trust entries with
  Cloudflare's [official IP ranges](https://www.cloudflare.com/ips/) and keep
  them current. Restrict origin access to those ranges; verify real-IP handling
  before enabling traffic.
- **Direct clients:** do not trust a public client's forwarding headers. Keep
  the real-IP module configured to trust only actual, protected proxy sources;
  nginx then overwrites the header with the direct socket address. Configure
  and verify real-IP handling before exposing nginx directly. **Never expose
  nginx directly without configuring real_ip.**

`TRUST_PROXY` no longer changes application client-IP resolution. The services
warn at startup if it is present; X-Forwarded-For and X-Real-IP are not used
for this purpose.

The browser origin must be listed in `ADMIN_ALLOWED_ORIGINS`. Unsafe session
requests also require the matching CSRF header, so a cross-origin page cannot
reuse the cookie for state changes.

The central API also hosts the Student Auth boundary used by the Student SPA.
Configure `STUDENT_ACCESS_TEAM_DOMAIN`, `STUDENT_ACCESS_AUD`,
`STUDENT_SESSION_SECRET`, and `STUDENT_ALLOWED_ORIGINS` in the protected
server environment. Cloudflare Access must enforce email one-time PIN and
forward its signed assertion to the Student API. The session secret never
enters `VITE_*`, the browser bundle, logs, or API responses.

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

## Local admin password hash (development)

The local admin API (`pnpm --filter AI-adm-D1 server:dev`) loads the
repository-root `.env` through
`apps/AI-adm-D1/src/server/env.ts` (`projectRootEnvPath`, resolved as
`../../../../.env` from the server package). Values from `.env` are applied
only when the corresponding environment variable is not already set, so
deployment-injected env takes precedence and `.env` never overrides it.

### Setup

1. Read the password without echoing it:

   ```bash
   read -r -s ADMIN_PASSWORD_INPUT
   ```

2. Generate the scrypt hash with the existing helper (same command used for
   production):

   ```bash
   printf '%s\n' "$ADMIN_PASSWORD_INPUT" | node --import ./apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs scripts/hash-admin-password.mjs
   ```

3. Write the printed hash into `.env` as `ADMIN_PASSWORD_HASH=<hash>`, leave
   `ADMIN_PASSWORD` empty (or unset it), then clear the temporary variable:

   ```
   ADMIN_PASSWORD_HASH=scrypt$16384$8$1$<base64url-salt>$<base64url-derived>
   ADMIN_PASSWORD=
   ```

   ```bash
   unset ADMIN_PASSWORD_INPUT
   ```

4. Restart the admin API so the new hash is loaded.

The program prefers the hash when it is set:
`apps/AI-adm-D1/src/server/ai/admin-auth.ts` verifies `ADMIN_PASSWORD_HASH`
via scrypt first. Plaintext `ADMIN_PASSWORD` is only a local-development
fallback and is never used in production
(`verifyPassword` returns the plaintext comparison only when
`!config.production`). Do not leave plaintext or hashes in `.env` or backup
files; remove them after use. Examples use placeholders only — never real
account names, passwords, or hash values.

### Readiness check in `reset-ai-smartbook.sh`

`verify_admin_proxy` runs two modes depending on whether a plaintext
`ADMIN_PASSWORD` is present in `.env`:

- **Mode A — Full login probe** (plaintext `ADMIN_PASSWORD` present): reads
  `ADMIN_USERNAME` and `ADMIN_PASSWORD`, posts to
  `/api/admin/auth/login`, captures the `ai_admin_session` and
  `ai_admin_csrf` cookies, then probes `/api/admin/accounts` with those
  cookies. Expects login HTTP 200, both cookies present, and accounts
  HTTP 200.

- **Mode B — Unauthenticated proxy probe** (no plaintext `ADMIN_PASSWORD`):
  GETs `/api/admin/auth/me` without any credentials. Expects HTTP 401 with
  `Content-Type: application/json` and body
  `{"error":"admin authentication required"}`. This confirms the
  Vite → proxy → Admin API → AdminAuthMiddleware chain responded, without
  needing a password.

When a hash is configured but no plaintext is present, Mode B is used; the
hash itself is never sent over HTTP during the probe.
