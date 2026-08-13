# Foundation Baseline Validation Report

- **Date:** 2026-08-13
- **Repository:** AI-Quest-A1 (`/home/b827262/project/AI-Quest-A1`)
- **Validation worktree:** `.worktrees/foundation-baseline-validation` (isolated, clean)
- **origin/main before integration:** `ac2d31d4f2931bd21b82c4eed44ea694887b8829`
- **Foundation candidate (original HEAD):** `e60b708d3cf1dd29dc21a998f29bfc7e4faf8489`
- **Integration branch:** `integration/foundation-baseline`
- **Tested code HEAD (round 2):** `f531728` (`fix(admin): restore guest retention boundary`)
- **Report HEAD (round 2 docs commit):** see `git log` — documentation-only commit on top of `f531728`
- **Round 1 tested code HEAD:** `00dd8e9cc08c7269a14b3fa87b4f93cfd8479a06` (round 1 report commit `eee4354`)
- **merge-base(origin/main, candidate):** `ac2d31d4f2931bd21b82c4eed44ea694887b8829`
- **Topology:** ahead_by = 6 (original foundation commits) + 2 hardening commits + 1 retention-boundary fix, behind_by = 0; original 6 commits preserved verbatim, no rewrite/squash
- **Books exclusion check:** `git merge-base e39b312 e60b708` = `e60b708` — `e39b312` is a child of the foundation HEAD and is NOT part of this branch

## Commit list (original 6)

| # | SHA | Subject | Verdict |
|---|-----|---------|---------|
| 1 | `c092a31` | feat(admin): add model quota action per credential | PASS — UI-only, single purpose (per-credential quota add button + e2e assertion), no server/auth/DB impact |
| 2 | `5fc2cf3` | fix(schema,db): allow nullable pricing fields in credential model quota schemas | PASS-WITH-NOTES — consistent zod/repo/TS widening, well tested; notes: undeclared vitest dep in schema package, brittle contract test (later removed) |
| 3 | `e9489ab` | test(admin): add specification tests for Gemini priority ASC, weight DESC and failover | PASS — pure test addition against real routing logic (real SQLite, real crypto, stubbed fetch); zero production changes |
| 4 | `57b8624` | test(admin): add HTTP readiness and app boundary | PASS-WITH-NOTES — behavior-preserving `index.ts` → `app.ts`/`dependencies.ts` split, DI factory without `listen`, additive health endpoints; notes: GUEST_ASK_RETENTION_DAYS clamp dropped in dependencies.ts, credential-quota contract test deleted (coverage superseded by integration test), incidental lockfile float (vite 8.1.5→8.2.0 etc.), dev-proxy token injection (dev-only, bundle guard covers browser side). **Defect found:** production bundle not bootable (see Issues) |
| 5 | `23c8ec5` | feat(admin): add session authentication flow | PASS-WITH-NOTES — 256-bit session/CSRF tokens stored only as SHA-256 digests, HttpOnly/Secure/SameSite=Strict cookies, scrypt + timing-safe compare, server-bound CSRF, pre-listen production fail-closed, full audit trail; notes: no login rate limiting, production guarantees hinge on `NODE_ENV=production` |
| 6 | `e60b708` | chore(admin): define production auth deployment boundary | PASS-WITH-NOTES — nginx token-scrubbing proxy, systemd production unit, scrypt hash script consistent with verifier; notes: unrelated student-app cleanups mixed in (harmless), deployment defects fixed below |

## Hardening commits (added after the original 6)

| SHA | Subject | Root cause | Regression test |
|-----|---------|-----------|-----------------|
| `7c82be6` | fix(admin): make production server bundle bootable | `server:build` externalizes `better-sqlite3` (and bundled pdfjs-dist browser build from `pdf-parse`), but the externals were not resolvable from `AI-adm-D1` at runtime → `dist-server/admin-api.mjs` crashed at import; the documented production start path could never boot | `apps/AI-adm-D1/src/server/server-bundle-contract.test.ts` (every esbuild external must be a declared dependency) + runtime boot matrix P-3 |
| `00dd8e9` | fix(deploy): harden admin production deployment boundary | nginx conf lacked `client_max_body_size` (1 MB default rejects 25 MB JSON-index uploads; repo's own production verification requires the directive); systemd unit ran as root; `admin.env.example` omitted production-required `GUEST_ASK_IP_HMAC_SECRET` (server refuses to boot without it) | `apps/AI-adm-D1/src/server/deployment-boundary.test.ts` (5 tests) |

## Files changed summary (`ac2d31d..00dd8e9`)

48 files changed, +7035 / −5017. Major areas:

- `apps/AI-adm-D1/src/server/{index,app,dependencies}.ts` — bootstrap/app/DI split; session auth endpoints; audit middleware; health endpoints
- `apps/AI-adm-D1/src/server/ai/admin-auth.ts`, `admin-origin.ts` — scrypt verification, session/CSRF middleware, production asserts, origin allowlist
- `apps/AI-adm-D1/src/{admin-auth.tsx,api.ts,App.tsx,pages/AdminLoginPage.tsx}` — browser session login UI, cookie-based fetch client (no storage secrets)
- `packages/db/src/{schema.ts,migrate.ts,repositories/adminSession.repo.ts}` — `admin_sessions` table + idempotent migration + session repository
- `packages/schema/src/aiGateway.schema.ts` — nullable pricing fields
- `deploy/nginx/ai-admin-r1.conf`, `deploy/systemd/*`, `deploy/scripts/install-admin-systemd.sh`, `docs/ADMIN_AUTH_DEPLOYMENT.md` — production deployment boundary
- `scripts/hash-admin-password.mjs`, `scripts/production-verification.mjs` — hash tooling, negative token-injection check
- Tests: `admin-auth.test.ts`, `admin-api.integration.test.ts`, `gemini-priority.test.ts`, `security-bundle.test.ts`, `deployment-boundary.test.ts`, `server-bundle-contract.test.ts`

## Architecture review

- `index.ts` is pure bootstrap: `loadRootEnv()` → `assertAdminAuthConfig()` (fail fast before listener) → `createAdminDependencies()` → `createAdminApp(deps).listen()`. App factory never listens; tests exercise real routes via supertest without process globals.
- Env loading responsibility stays at the root bootstrap; `app.ts` receives env via dependency injection.
- SQLite handle lifecycle: single handle created in `createAdminDependencies`, migrations run at the process boundary; no regression observed (fresh/upgrade/re-run matrix below).
- `/api/admin` middleware chain: origin → auth → CSRF → mutation audit, mounted once; login route registered before the auth mount.
- Public/student surface untouched and verified open (R-1/R-2); CLI/internal token path (`X-Admin-Token`/Bearer) preserved and CSRF-exempt by contract.

## Security review

- Sessions: 32-byte base64url tokens (session + CSRF), only SHA-256 digests persisted (`token_digest UNIQUE`); raw tokens never in SQLite (verified D-8).
- Cookies: `HttpOnly; Secure; SameSite=Strict; Path=/` for session; CSRF cookie readable by SPA, same Secure/SameSite.
- Password: scrypt (N=16384, r=8, p=1, 32-byte key, 16-byte salt) with timing-safe compare; plaintext `ADMIN_PASSWORD` rejected in production.
- CSRF: unsafe methods + session-kind only; requires allowlisted `Origin`, header==cookie (timing-safe), and digest bound to the session row (defeats cookie planting). GETs unaffected.
- Production fail-closed: missing username/hash or `ADMIN_SESSION_SECURE=false` throws before listen (A-1..A-4 runtime-verified).
- Browser bundle: zero occurrences of `ADMIN_API_TOKEN`, `ADMIN_PASSWORD`, `VITE_*` secret patterns, `localStorage`, `sessionStorage`, or `Bearer` in `dist/` (grep counted); `security-bundle.test.ts` pins this.
- Audit: `admin.auth.login.failed|succeeded`, `admin.auth.logout`, `admin.request.mutation` with `actorId/method/path/statusCode`; metadata allowlisted; no password/token/cookie material present (D-7a..f).
- Nginx boundary clears `X-Admin-Token` and `Authorization` (browser cannot supply a permanent credential); health endpoints are unauthenticated liveness only; `X-Forwarded-Proto` set.

## DB migration review

- Migration is `CREATE TABLE IF NOT EXISTS` + guarded `addColumnIfMissing`, single transaction, idempotent.
- `admin_sessions`: `token_digest UNIQUE`, indexes on `expires_at` and `username`; lazy expiry revocation on lookup; `purgeExpired` on login.
- Rollback: not supported (additive DDL only; no down migration). Recorded explicitly per contract.

## Deployment review

- systemd: production node bundle entry (`dist-server/admin-api.mjs`), `EnvironmentFile=/etc/ai-quest-a1/admin.env` (chmod 600, never clobbered), `NODE_ENV=production`, `Restart=always`, now non-root `User=ai-adm-d1`/`Group=ai-adm-d1` with install-script provisioning; no `pnpm dev`/`vite` anywhere; no hardcoded secrets.
- nginx: HTTPS-only assumption documented (Secure cookies), SPA fallback, explicit health proxies, `client_max_body_size 32m` added.
- `scripts/hash-admin-password.mjs` reads password from stdin (never argv) and emits the exact scrypt format the verifier parses.

## Test environment

- Node v24.18.1, pnpm 9.15.0, Linux x64
- Isolated worktree at `.worktrees/foundation-baseline-validation`
- Production bundle: `apps/AI-adm-D1/dist-server/admin-api.mjs` (esbuild, node22 target)

## Commands executed

```bash
git fetch origin --prune
git rev-parse origin/main / merge-base / rev-list --count
git worktree add .worktrees/foundation-baseline-validation e60b708...
pnpm install --frozen-lockfile          # twice: at e60b708 and clean at final HEAD
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm test
pnpm run typecheck:release-scripts
pnpm run lint:release-scripts
pnpm --filter AI-adm-D1 build
pnpm --filter AI-adm-D1 server:build
pnpm --filter AI-adm-D1 exec vitest run <targeted files>
pnpm --filter @ai-smartbook/ai exec vitest run test/guest-surface-contract.test.ts
node /tmp/foundation-adversarial/adv-foundation.mjs   # 3 runs: fresh / upgrade / re-run
# origin/main cross-check tree at /tmp/foundation-main-check (frozen install + typecheck:release-scripts)
grep -RniF patterns apps/AI-adm-D1/dist               # bundle secret scan
```

## Gate results

| Gate | Result | Notes |
|------|--------|-------|
| frozen install (`pnpm install --frozen-lockfile`, clean node_modules) | PASS | exit 0, at e60b708 and at final HEAD |
| typecheck (`pnpm run typecheck`) | PASS | |
| lint (`pnpm run lint`) | PASS | |
| build (`pnpm run build`) | PASS | |
| tests (`pnpm test`) | PASS | schema 4, ai 604, db 167, stu 5, adm 215+6 new = 1001 total |
| typecheck:release-scripts | FAIL (pre-existing on origin/main) | `scripts/provider-live-smoke.ts` misses `zai` in `Record<ManagedProvider, …>`. Evidence: script byte-identical across the 6 commits; `zai` already in origin/main's `aiProviderIdSchema`; identical error reproduced on a clean origin/main checkout (`/tmp/foundation-main-check`). Not caused by foundation; not fixed here (outside foundation scope) |
| lint:release-scripts | PASS | |
| admin auth tests | PASS | 7/7 |
| admin API integration | PASS | 6/6 |
| CSRF | PASS | runtime matrix C-1..C-5, C-X1/C-X2 |
| DB migration | PASS | D-1..D-8 incl. pre-foundation upgrade |
| security bundle | PASS | 1/1 + manual grep counts all 0 |
| production client build | PASS | |
| production server build | PASS | |
| production boot (valid config) | PASS | after hardening fix 7c82be6; FAILED on original e60b708 |
| production boot (invalid config) | PASS | fail closed, A-1..A-4 |
| route isolation | PASS | R-1..R-6 |
| deployment review | PASS | after hardening fix 00dd8e9 |
| targeted: gemini-priority / guest-surface-contract / deployment-boundary / server-bundle-contract | PASS | 4/4, 6/6, 5/5, 1/1 |

## Adversarial matrix (runtime, against production bundle)

All items executed by `/tmp/foundation-adversarial/adv-foundation.mjs`; 43/43 PASS on each of three runs (fresh DB, pre-foundation DB upgrade, second migration run).

| ID | Case | Result |
|----|------|--------|
| A-1 | production missing username → boot fails | PASS |
| A-2 | production missing hash → boot fails | PASS |
| A-3 | production plaintext password only → boot fails | PASS |
| A-4 | production insecure cookie → boot fails | PASS |
| A-5 | wrong password → 401 + audit | PASS |
| A-6 | expired session → 401 (lazy revoke persisted) | PASS |
| A-7 | revoked session → 401 | PASS |
| A-8 | cookie reuse after logout → 401 | PASS |
| A-9 | forged cookie → 401 | PASS |
| A-10 | malformed cookie → 401 | PASS |
| C-1 | mutation without CSRF → 403 | PASS |
| C-2 | mutation with wrong CSRF → 403 | PASS |
| C-3 | GET without CSRF → 200 | PASS |
| C-4 | CSRF after logout → rejected | PASS |
| C-5 | CSRF from another session → 403 | PASS |
| C-X1/X2 | missing / non-allowlisted Origin → 403 | PASS |
| B-1..B-6 | bundle contains no ADMIN_API_TOKEN / password / VITE_ secrets / localStorage / sessionStorage / permanent bearer | PASS (all counts 0) |
| R-1 | public route open | PASS |
| R-2 | student route open | PASS |
| R-3 | admin unauthenticated → 401 | PASS |
| R-4 | session GET → 200 | PASS |
| R-5 | session mutation w/o CSRF → 403 | PASS |
| R-6 | session mutation with CSRF → 201 | PASS |
| TOK-1..4 | X-Admin-Token / Bearer accepted; wrong token 401; token mutations CSRF-exempt | PASS |
| D-1 | fresh DB migrate | PASS |
| D-2 | pre-foundation (ac2d31d) DB upgrade: 44→45 tables, `admin_sessions` added, data intact | PASS |
| D-3 | migration second run idempotent (full matrix re-run) | PASS |
| D-4/D-5 | session create/revoke persisted | PASS |
| D-6 | expiry enforced and persisted | PASS |
| D-7 | audit events + safe metadata (no credentials) | PASS |
| D-8 | raw session token never stored | PASS |
| P-1/P-2 | client + server production builds | PASS |
| P-3 | valid production boot | PASS |
| P-4 | invalid production boot fail closed | PASS |
| P-5/P-6 | health live/ready | PASS |
| P-7/P-8 | nginx + systemd boundary review (fixed by 00dd8e9, pinned by tests) | PASS |

## Issues found and disposition

1. **BLOCKER (fixed, `7c82be6`):** production server bundle could not boot — externalized `better-sqlite3` undeclared by `AI-adm-D1`; `pdf-parse` bundled pdfjs-dist browser build crashing on `DOMMatrix`. Declared both deps, externalized `pdf-parse`; contract test added; runtime-verified.
2. **Production security flaws (fixed, `00dd8e9`):** nginx missing `client_max_body_size`; systemd running as root; `admin.env.example` missing production-required `GUEST_ASK_IP_HMAC_SECRET`. All fixed and pinned by regression tests.
3. **Pre-existing on origin/main (not fixed, evidence above):** `typecheck:release-scripts` failure (`zai` missing in provider-live-smoke.ts). Outside foundation scope.
4. **BLOCKER FOUND DURING INDEPENDENT REVIEW — FIXED by `f531728`:** `GUEST_ASK_RETENTION_DAYS` boundary regression (details in the Round 2 section below).

## Round 2 — independent review blocker: guest retention boundary

- **Root cause:** the app/dependency split (57b8624) replaced the shared `resolveGuestAskRetentionDays(env)` call (used by `index.ts` at `ac2d31d`) with `Number(env.GUEST_ASK_RETENTION_DAYS || 7)` in `apps/AI-adm-D1/src/server/dependencies.ts`, dropping the contract: default 7, invalid/≤0 → default, floor, clamp to [1, 90].
- **Before (evidence at `eee4354`):** the new regression test failed for RET-2 (`"abc"` → `NaN`), RET-3 (`"0"`/`"-5"` → `0`/`-5`), RET-4 (`"0.5"` → `0.5`), RET-5 (`"999"` → `999`, expected `90`), RET-6 (`"12.8"` → `12.8`).
- **After:** `dependencies.ts` imports and uses `resolveGuestAskRetentionDays(env)` from `@ai-smartbook/ai` (the existing source of truth; no re-implementation).
- **Regression test:** `apps/AI-adm-D1/src/server/dependencies-retention.test.ts` — RET-1..RET-7 driven through `createAdminDependencies()` (the integration boundary, not just the resolver). 7/7 PASS at `f531728`.
- **Runtime RET matrix:** production bundle booted per env value; retention proven by the actual `guest_ask_answers.expires_at` horizon: unset→7.00d, `abc`→7.00d, `-5`→7.00d, `0.5`→1.00d, `999`→90.00d, `12.8`→12.00d, `30`→30.00d. 7/7 PASS.
- **Retested gates at `f531728`:** frozen install PASS; typecheck PASS; lint PASS; build PASS; workspace tests PASS (schema 4, ai 604, db 167, stu 5, adm 221 incl. 7 new RET tests); lint:release-scripts PASS; production client + server builds PASS; foundation targeted gates PASS (admin-auth 7, admin-api.integration 6, gemini-priority 4, security-bundle 1, deployment-boundary 5, server-bundle-contract 1, dependencies-retention 7, guest-surface-contract 6); existing adversarial matrix 43/43 PASS ×3 runs (fresh DB, pre-foundation upgrade, migration re-run); RET runtime matrix 7/7 PASS.
- **`typecheck:release-scripts`** still fails with the identical, independently-confirmed pre-existing `zai` errors in `scripts/provider-live-smoke.ts`; that file was not modified in round 2 (round 2 diff = `dependencies.ts` + regression test only).
- **New tested code HEAD:** `f531728`.

## Remaining risks (documented, not blocking)

- No login rate limiting/lockout on `/api/admin/auth/login` (audit-only). Recommend follow-up.
- Production guarantees depend on `NODE_ENV=production` being set (systemd example sets it).
- Production without `ADMIN_ALLOWED_ORIGINS` locks out SPA mutations (fail-closed, but operationally fragile).
- ~~`GUEST_ASK_RETENTION_DAYS` [1,90] clamp dropped in dependencies.ts (introduced by 57b8624)~~ — **BLOCKER FOUND DURING INDEPENDENT REVIEW; FIXED by `f531728`** (see Round 2 section).
- Lockfile float in 57b8624 (vite 8.1.5→8.2.0, tsx patch, rolldown bindings) — accepted as installed-and-tested.
- Commit e60b708 mixes unrelated student-app cleanups (no functional impact).
- Migration rollback unsupported (additive-only DDL).
- No CSP header in nginx conf (X-Content-Type-Options/X-Frame-Options/Referrer-Policy present).

## Books exclusion statement

Books commit `e39b312` is intentionally NOT included in this branch or PR. `git merge-base e39b312 e60b708` = `e60b708`, i.e. Books builds on top of the foundation and remains blocked until this foundation baseline is merged and Books is separately rebased and validated. No Books test result was used as foundation evidence.

## Note on report commit

Round 1 runtime/build evidence was gathered at code HEAD `00dd8e9` (report commit `eee4354`). Round 2 runtime/build evidence was gathered at code HEAD `f531728`; this updated report is committed as a separate documentation-only commit on top of it and changes no code, lockfile, or test files. Neither report commit is itself a runtime-tested code SHA.

## Final verdict

**VERIFIED**
