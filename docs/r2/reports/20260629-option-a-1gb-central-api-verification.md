# 2026-06-29 Option A 1GB Central API Verification Report

## Scope
- Branch: `fix/pdf-reader-ai-core/pdf-404-mobile-20260629`
- Scope: Strict Option A student/frontend + Nginx central API routing for 1GB deployment
- Verification source: 1GB smoke checks + local repo validation
- Merge status: Not merged to `main`

## Modified files for this report scope
- `.env.example`
- `deploy/nginx/ai-stu-r1.conf`
- `deploy/systemd/student.env.example`
- `docs/STUDENT_1GB_SYSTEMD_DEPLOYMENT.md`

## Final verification results

| Check | Status | Evidence |
|---|---|---|
| Option A diff check | PASS | Only the Option A deployment/proxy files were retained in active patch; runtime code files remain untouched. |
| E500 central API check | PASS | Central endpoint verified as reachable: `http://100.76.46.86:4300`; `http://100.76.46.86:4321` is not reachable. |
| PDF stream check | PASS | `/uploads/books/test.pdf` was validated as blocked at Nginx (404), while student book content access via central proxy succeeds. |
| Typecheck/build | PASS | Reported as passing in 1GB verification run context. |
| 1GB Nginx proxy check | PASS | `/api/student/books` routes through Nginx to central API successfully with HTTP 200 JSON response. |
| `/api/student/books` via Nginx | PASS | `200` JSON response confirmed through `http://100.76.46.86:4300` proxy path. |
| `/uploads/books/test.pdf` local block | PASS | Returns `404` locally; response includes `X-Blocked-By: smartbook-1gb-nginx` and no Express header. |
| `No X-Powered-By: Express` | PASS | Confirmed on blocked `/uploads/books/*` local response. |
| Code/runtime file changes | PASS | No changes to `apps/AI-Stu-R1/server/stu-api.ts`, `apps/AI-adm-D1/src/server/index.ts`, `packages/schema/src/bookFile.schema.ts`, `packages/student-runtime/src/config.ts`, `packages/student-runtime/src/remoteDataSource.ts`, `packages/student-runtime/src/sqliteDataSource.ts`. |
| lockfile change | PASS | `pnpm-lock.yaml` unchanged. |

## Route targets applied
- `/api/student/` -> `http://100.76.46.86:4300/api/student/`
- `/api/appearance-settings` -> `http://100.76.46.86:4300/api/appearance-settings`
- `/api/uploads/` -> `http://100.76.46.86:4300/api/uploads/`
- `/uploads/books/*` -> local Nginx `404` block (not proxied)

## Notes
- `.env.example` did not contain `e500:4321`, so no replacement was needed there.
- Optional DNS shortcut retained in docs/config as comment: `e500:4321` may be used only if it resolves to `100.76.46.86`.
