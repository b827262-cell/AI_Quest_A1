# AI_Quest_A1 現況盤點（Current State Inventory）

- **基準版本**：`origin/main` = `05628502777be9de93d1babe4b260fa80b6f3f2a`（2026-11-13；已含 PR #145 安全文件與 PR #146 學員資料擁有者隔離）
- **票號**：N-R528（Issue #21，母票 #17；更新 N-R514 底稿）
- **性質**：唯讀盤點。本文件只記錄現況與證據，**不修改任何產品行為、不修補安全缺陷、不新增 migration**。
- **引用方式**：本文沿用的既有 `path:line` 以 N-R514 基線為背景；第 11 章新增／更新的行號錨點已逐一對照 `0562850`。PR #145/#146 變更處以最新行號為準。
- **範圍**：`apps/`、`packages/`、`site/`、`scripts/`、`deploy/`、`.github/`，以及 `docs/` 中既有的治理與部署文件。

> 本文件刻意區分「**現況**」、「**證據位置**」、「**缺口**」、「**阻塞**」。
> 「阻塞」指目前無法完成驗證或無法安全推進某項工作的具體原因，不是待辦清單。

---

## 0. 摘要

| 面向 | 現況一句話 |
|---|---|
| 應用程式 | 兩個 Node/Express + React SPA（Admin、Student），加一個 Cloudflare Workers / vinext 的 `site/` 三站部署 |
| 身分 | Admin：帳密 + scrypt + server-side session + CSRF；Student：Cloudflare Access JWT 或 passcode + server-side session |
| 資料 | 主要為單一 SQLite（`packages/db`）；`site/` 另有 D1 + R2 |
| AI | `packages/ai` 提供 gateway、provider 輪替、budget、orchestration、RAG、evaluation；**沒有 tool calling、沒有 QM adapter** |
| 測試 | root workspace 155 個 test files / 1,685 項；`site/` 另有 30 個 `node:test` 檔；**沒有 GitHub Actions workflow** |
| 學員資料隔離 | PR #146 已把 notes 與 chat/progress 綁定至已驗證的學員；舊 `student_id` / `user_id` 為 NULL 的資料在學員端 fail-closed、保留且不猜測歸屬（notes list 隱藏；跨 owner 的 note write 與舊 session 路徑回 404） |
| 最大未解缺口 | 未知 API route 回 HTML 404；site 測試不在 root `pnpm test`；QM 能力不存在；PR #145 的安全文件仍把 G1/G2 寫成待合併，文件狀態需更新 |

---

## 1. apps 與 packages 的 entry points 與依賴方向

### 1.1 佈局

```
apps/
  AI-adm-D1/     Admin SPA + Admin API（Express）+ 部分 Student API（同進程）
  AI-Stu-R1/     Student SPA + Student API（Express，可 remote-api 代理 Admin）
packages/
  ai/            舊版 provider + gateway + orchestration + evaluation + RAG
  auth/          Student/Admin 共用的 session、passcode、Access、learning-history
  book-core/     PDF 解析、章節切分、書本問答
  contracts/     對外 wire contract（browser/server 入口分離）
  db/            SQLite schema、migration、repositories、seed
  quiz-core/     題庫 domain
  schema/        Zod schema 與共用型別
  student-runtime/ Student 資料來源（static / sqlite-api / remote-api）
  sync/          E500 同步匯出
  ui/            共用 React 元件
site/            Cloudflare Workers + vinext 三站（backend / student / admin）
```

### 1.2 Server / browser entry points

| 單元 | Browser entry | Server entry | 證據 |
|---|---|---|---|
| Admin SPA | `apps/AI-adm-D1/src/main.tsx` | — | `apps/AI-adm-D1/index.html`、`vite.config.ts` |
| Admin API | — | `apps/AI-adm-D1/src/server/index.ts`（`ADMIN_API_PORT` 預設 4300） | `apps/AI-adm-D1/src/server/index.ts:14-19` |
| Student SPA | `apps/AI-Stu-R1/src/main.tsx` | — | `apps/AI-Stu-R1/index.html`、`vite.config.ts` |
| Student API | — | `apps/AI-Stu-R1/server/stu-api.ts`（`STU_API_PORT` 預設 4310） | `apps/AI-Stu-R1/server/stu-api.ts:18-33`、`:331` |
| Site Worker | `site/app/*`（vinext app router） | `site/worker/index.ts` | `site/worker/index.ts:1-40` |
| `@ai-smartbook/ai` | `packages/ai/src/browser.ts` | `packages/ai/src/server.ts` | `packages/ai/package.json` exports |
| `@ai-smartbook/auth` | `packages/auth/src/browser.ts` | `packages/auth/src/server.ts`、`./express`、`./passcode` | `packages/auth/package.json` exports |
| `@ai-smartbook/contracts` | `packages/contracts/src/browser.ts`（預設 `.`） | `packages/contracts/src/server.ts` | `packages/contracts/package.json` exports |
| `@ai-smartbook/db` | 無 browser entry | `packages/db/src/index.ts` | `packages/db/package.json`（無 exports map） |
| `@ai-smartbook/schema` | 無 browser/server 分離 | `packages/schema/src/index.ts` | `packages/schema/package.json`（無 exports map） |

### 1.3 依賴方向（宣告層）

| 單元 | 允許依賴 | 禁止依賴 | 證據 |
|---|---|---|---|
| Student browser | `contracts`、`schema`、`ui`、`student-runtime` 的 browser-safe 部分 | `@ai-smartbook/ai`、`@ai-smartbook/db`、Node API、provider SDK | `docs/MODULE_OWNERSHIP.md:15`；`scripts/boundary-check.sh:14-27` |
| Admin browser | `contracts`、`schema`、`ui`、`@ai-smartbook/ai/browser` | `@ai-smartbook/db`、`@ai-smartbook/ai/server`、secrets | `docs/MODULE_OWNERSHIP.md:16`；`apps/AI-adm-D1/src/client-boundary.test.ts:15-31` |
| Admin server | contracts、domain/orchestration public API、DB、server adapters | browser 實作、raw exception 直出 | `docs/MODULE_OWNERSHIP.md:17` |
| Student server | domain/schema/DB public API | Admin-only services、browser internals | `docs/MODULE_OWNERSHIP.md:18` |
| `packages/ai` browser | pricing、RAG、pilot readiness 純函式 | Node built-ins、secrets、DB | `packages/ai/src/browser.ts:1-24`；`apps/AI-adm-D1/src/client-boundary.test.ts:20-31` |
| `packages/ai` server | ip-hash、recovery-token、RAG server adapters | React/apps | `packages/ai/src/server.ts:1-4` |
| `packages/book-core` | schema、純 domain utilities | `@ai-smartbook/ai`、`@ai-smartbook/db` | `scripts/boundary-check.sh:31-120` |
| `packages/student-runtime` | schema、better-sqlite3 | `@ai-smartbook/ai` | `scripts/boundary-check.sh:29-35` |

### 1.4 缺口與阻塞

| 缺口 | 證據 | 影響 |
|---|---|---|
| 部分 package 沒有 `exports` map（`db`、`schema`、`student-runtime`、`book-core`、`quiz-core`、`ui`、`sync`），deep import 只靠 review 約束 | `packages/*/package.json` | 邊界不是機器強制，只能靠 `boundary-check.sh` 與 code review |
| `docs/MODULE_OWNERSHIP.md` 說「多數 HTTP DTO 早於 `packages/contracts`」 | `docs/MODULE_OWNERSHIP.md:66-67` | contract 覆蓋率不完整，endpoint-by-endpoint 遷移尚未完成 |
| `apps/AI-adm-D1` 同時掛載 Student routes（`/api/student/*`） | `apps/AI-adm-D1/src/server/app.ts:1753-1779` | Admin 進程承擔兩種信任邊界；部署與測試需同時考量 |
| `packages/db` 的 `main` 直接指向 `src/index.ts`（TypeScript 原始碼） | `packages/db/package.json` | 消費端需靠 tsx/tsc 或 bundler，不是預編譯套件 |

**阻塞**：無（此區塊為結構性缺口，不阻擋閱讀或測試）。

---

## 2. Admin 與 Student 的 API routes、權限 middleware、資料 scope

### 2.1 Admin API

#### 權限邊界（順序）

1. `app.use("/api/admin", createAdminOriginMiddleware(env))`：只做 CORS/Origin 檢查，**不是認證**（`apps/AI-adm-D1/src/server/app.ts:350`；`apps/AI-adm-D1/src/server/ai/admin-origin.ts:21-40`）。
2. `adminBoundary.protectRoutes(app)`：對所有 `/api/admin/*` 掛上 `authenticate` → `csrf` → mutation audit（`apps/AI-adm-D1/src/server/app.ts:426`；`apps/AI-adm-D1/src/server/admin-route-boundary.ts:23-41`）。
3. 各 handler 內再呼叫 `requireAdminAccess(req, res)` 作為 defence-in-depth（`apps/AI-adm-D1/src/server/app.ts:974-982`）。

#### Route 群組（代表路徑）

| 群組 | 代表 routes | 證據 |
|---|---|---|
| Auth | `POST /api/admin/auth/login`、`GET /api/admin/auth/me`、`POST /api/admin/auth/logout` | `app.ts:368-424` |
| Dashboard / diagnostics | `GET /api/admin/dashboard/stats`、`GET /api/admin/diagnostics/guest-usage` | `app.ts:1820`、`app.ts:1861` |
| Site config | `GET/PUT /api/admin/site-config` | `app.ts:2129-2143` |
| Exam snapshots | `GET /api/admin/exam-snapshots`、`POST /api/admin/exam-snapshots/:year/refresh-today`、`GET /api/admin/exam-snapshots/:year/jobs/:jobId` | `apps/AI-adm-D1/src/server/exam-snapshot/admin-router.ts:78-105` |
| Books / 教材 | `GET/POST /api/admin/books`、`POST /api/admin/books/:bookId/files`、`POST .../parse-content`、`POST .../outline-preview`、`POST .../generate-json-index`、reader-toc、chapters、contents、json-indexes | `apps/AI-adm-D1/src/server/books-router.ts:81-740`（37 個 handler） |
| AI providers / credentials | `/api/admin/ai-providers*`、`/api/admin/ai-credentials*`、`/api/admin/ai-credential-quotas*` | `app.ts:2232-2690` |
| AI analytics | `/api/admin/ai-analytics/*`、`/api/admin/ai-requests*`、`/api/admin/ai-usage/:requestId` | `apps/AI-adm-D1/src/server/ai-analytics-router.ts:18-103` |
| AI evaluations / governance / pilot | `/api/admin/ai-evaluations*`、`/api/admin/ai-evaluation-*`、`/api/admin/ai-pilot/*` | `apps/AI-adm-D1/src/server/ai-evaluations-router.ts:82-342`；`app.ts:2699-2747` |
| AI budget / token pools / models / quota center | `/api/admin/ai-budget-policies*`、`/api/admin/ai-token-pools*`、`/api/admin/ai-logical-models*`、`/api/admin/ai-model-limits*`、`/api/admin/ai-token-usage/*`、`/api/admin/ai-quota-center/*` | `app.ts:2749-3103` |
| Accounts | `GET /api/admin/accounts`、`PATCH /api/admin/accounts/:sessionId/risk`、`PATCH .../block` | `apps/AI-adm-D1/src/server/accounts-router.ts:18-70` |
| Student passcodes | `GET/POST /api/admin/student-passcodes*`、`POST .../:id/reset`、`PATCH .../:id/status` | `apps/AI-adm-D1/src/server/student-passcodes-router.ts:11-33` |
| Student questions | `GET /api/admin/student-questions`、`DELETE .../:id`、`POST .../delete` | `apps/AI-adm-D1/src/server/student-questions-router.ts:7-38` |
| Learning history | `GET /api/admin/learning-history`、`GET .../:studentId/:entryId` | `apps/AI-adm-D1/src/server/learning-history-router.ts:9-40` |
| Appearance | `GET /api/appearance-settings`（公開）、`PUT /api/admin/appearance-settings`、`POST /api/admin/appearance-settings/upload` | `app.ts:3104-3135` |
| Uploaded appearance files | `GET /api/uploads/appearance/:file`（只允許 png/jpg/webp） | `app.ts:352-357` |
| Health | `GET /health/live`、`GET /health/ready`（公開） | `app.ts:337-349` |
| Public guest | `GET /api/public/site-config`、`POST /api/public/guest-ask`、`GET /api/public/guest-ask/:requestId`、`POST /api/public/guest-feedback` | `app.ts:1882-2127` |

#### 資料 scope

- Admin 是單一管理員模型，**沒有 tenant/org/role 維度**；通過認證後可讀寫整個 SQLite。
- `adminAuth` 只有兩種 kind：`session` 與 `token`，session 帶 `id`/`username`，token 固定 `admin-api-token`（`apps/AI-adm-D1/src/server/ai/admin-auth.ts:20-24`、`:323-341`）。
- Mutation audit 只記錄 `POST/PUT/PATCH/DELETE` 的 method、path、status、actor（`admin-route-boundary.ts:27-39`）。

### 2.2 Student API

#### 權限邊界

- Student SPA 的 `/api/student/*` 由 `createStudentSessionMiddleware` 保護（`apps/AI-Stu-R1/server/stu-api.ts:150-151`）。
- 沒有 session → `401 AUTH_REQUIRED` 或 `SESSION_EXPIRED`；profile 未完成 → `403 PROFILE_INCOMPLETE`（`packages/auth/src/express.ts:77-96`）。
- `learning-history` 另外有 origin guard 與 256 KiB body limit（`packages/auth/src/learning-history-express.ts:107-150`）。
- RAG route 先經 session/profile，再由 route 參數與 session 推導 `studentId`/`bookId`，**不接受 body 傳入的 identity/scope**（`apps/AI-Stu-R1/server/student-rag.ts:328-380`）。

#### Route 群組

| 群組 | 代表 routes | 證據 |
|---|---|---|
| Auth | `GET /api/student/auth/access/login`、`POST /api/student/auth/passcode/login`、`GET .../google/start`、`GET .../google/callback`（固定 404）、`GET .../me`、`POST .../logout`、`GET/PATCH .../profile` | `packages/auth/src/express.ts:109-199` |
| Learning history | `GET/POST/PUT/DELETE /api/student/learning-history*` | `packages/auth/src/learning-history-express.ts:125-158` |
| RAG | `POST /api/student/books/:bookId/rag-ask` | `apps/AI-Stu-R1/server/student-rag.ts:328` |
| Books / reader | `GET /api/student/books`、`/:bookId`、`/:bookId/outline`、`/:bookId/contents`、`/:bookId/notes`（CRUD）、`/:bookId/session`、`/:bookId/files/:fileId/pdf-view`、`/:bookId/chat`、`/:bookId/chat-sessions/:sessionId`、`/:bookId/progress-summary`、`/:bookId/progress`、`/:bookId/reader-actions/complete`、`/:bookId/knowledge-points*` | `apps/AI-adm-D1/src/server/student-books-router.ts:117-555`；`apps/AI-Stu-R1/server/stu-api.ts:163-315` |
| Health | `GET /health/live`、`GET /health/ready` | `apps/AI-Stu-R1/server/health-routes.ts:115-125` |
| Appearance | `GET /api/appearance-settings`（回 schema 預設） | `apps/AI-Stu-R1/server/stu-api.ts:144-148` |

#### 資料 scope（重要）

| 資料 | 目前的 key | 是否綁 `studentId` | 證據 / 缺口 |
|---|---|---|---|
| Learning history | `req.studentAuth.user.id` | 是 | `packages/auth/src/learning-history-express.ts:128-155` |
| RAG 檢索 | `{ studentId: auth.user.id, bookId }` | 是 | `apps/AI-Stu-R1/server/student-rag.ts:360-375` |
| 書本內容 / 章節 / PDF | `bookId` + published 狀態 | 否（公開教材） | `student-books-router.ts:117-201` |
| Smart notes | `(bookId, studentId)`；studentId 取自已驗證 session，不取 request body | **是** | `apps/AI-adm-D1/src/server/student-books-router.ts:212-226`、`:229-269`；`packages/db/src/repositories/smartBookNote.repo.ts:20-49` |
| Chat session / progress / knowledge point 狀態 | `chat_sessions.user_id` 綁定已驗證的 `studentId`；client header/body 仍只用來選 session，不能授權跨 owner | **是（有 session row 的路徑）** | `apps/AI-adm-D1/src/server/app.ts:1596-1652`；`student-books-router.ts:323-363`、`:417-453`、`:532-563` |
| PDF session | in-memory `pdfSessions` map（8 小時） | 否 | `apps/AI-Stu-R1/server/stu-api.ts:34-37`、`:225-285` |

> **PR #146 後現況**：G1（notes）由 server-derived `studentId` 做 list/create/update/delete owner check；G2（chat/progress/session）建立時記錄 `userId`，讀寫時比對目前已驗證 student。跨 owner note 操作回 404；舊 NULL-owner note 不出現在 list，PATCH/DELETE 回 404。跨 owner 或 NULL-owner session 的相關讀寫路徑回 404。舊 row 保留，沒有 backfill 或刪除。session id/header/body 仍是 client 端選擇器，權限來自 cookie session 與 owner 比對。

### 2.3 Site（`site/`）routes 與 scope

| 群組 | 代表 routes | 權限 | 證據 |
|---|---|---|---|
| Health | `GET /api/health` | 公開（只回 role/site/binding 布林值） | `site/app/api/health/route.ts` |
| Admin | `GET /api/admin/auth/me`、`GET/POST /api/admin/books`、`GET /api/admin/overview` | `ADMIN_EMAILS` allowlist；否則 401/403 | `site/app/api/auth-helper.ts:20-44`；`site/app/api/admin/auth/me/route.ts` |
| Student | `GET /api/student/me`、`GET /api/student/books*`、`GET/PUT /api/student/progress` | 平台注入的 `oai-authenticated-user-*` 或 relay 驗證 | `site/app/api/student/me/route.ts`；`site/lib/relay-verification.ts` |
| Internal sync | `/api/internal/sync/books*`、`/students`、`/progress`、`/commit`、`/conflicts`、`/runs*` | `SYNC_IMPORT_SECRET` + HMAC 簽章 | `site/app/api/internal/sync/_shared.ts` |
| Sign-in | `/signin-with-chatgpt` | Dispatch 所有 | `site/app/signin-with-chatgpt/page.tsx` |

Site 的資料 scope 是「primary 站持有 D1/R2，secondary 站代理到 primary」；`site/deploy/targets.json` 明定三個 project 與 `primary_origin`，並由 `site/tests/three-site-topology.test.mjs` 驗證。

### 2.4 缺口與阻塞

| 缺口 | 證據 | 阻塞 |
|---|---|---|
| 安全基線文件未跟上 PR #146 | `docs/security/THREAT_MODEL.md:52,56,89-90,106`；`docs/security/ATTACK_CASES.md:12,53`；`docs/security/SECURITY_ACCEPTANCE_MATRIX.md:24,43,70-71` 仍將 G1/G2 標成 PR #146 未合併 | 更新安全文件中的 G1/G2 狀態與 acceptance 結果；本票只記錄，不改 `docs/security/*` |
| 教師／班級／課程的 object-level scope 尚未證明 | `packages/contracts/src/identity.ts`；目前沒有相應的教師/班級授權 API 測試 | 新增相關 API 前先定義 policy 與 A/B negative integration matrix |
| 未知 `/api/*` route 沒有 JSON 404 handler | Admin/Student 都只掛 error handler，沒有 catch-all 404；Express 預設回 HTML | 客戶端契約不一致；需要先決定 404 envelope 才能加測試 |
| Admin 只有單一管理員模型 | `admin-auth.ts:20-24` | 無法表達教師/助教/多角色 scope（Issue #17 的 fixtures 會需要） |
| Admin token 可繞過 CSRF | `createAdminCsrfMiddleware` 只對 `session` 生效（`admin-auth.ts:348-357`） | 自動化 token 遺失時的風險面；目前是刻意設計 |

---

## 3. 學員登入、Admin 登入、401/403/404

### 3.1 學員登入

#### (a) Cloudflare Access（Access email OTP）

- **現況**：Access 的 email OTP 在 Cloudflare edge 完成；應用只驗證 Cloudflare 轉送的 `Cf-Access-Jwt-Assertion`。不是應用自己寄 OTP。
- **驗證內容**：RS256、`kid`、JWKS（5 分鐘 cache、未知 kid 30 秒 cooldown）、`iss`、`aud`、`exp`/`nbf`/`iat`（60 秒 skew）、email 格式（`packages/auth/src/access.ts:71-125`）。
- **登入流程**：`GET /api/student/auth/access/login` → `verifyAccessAssertion` → 以 email 找/建 `student_users` → 建立 session → set cookie → 302（`packages/auth/src/express.ts:114-132`；`packages/auth/src/server.ts:323-353`）。
- **錯誤**：invalid token → `401 ACCESS_ASSERTION_INVALID`；email 衝突 → `403 ACCESS_EMAIL_CONFLICT`；Access 未設定/憑證不可用 → `503 ACCESS_UNAVAILABLE`。
- **Google OAuth**：程式碼仍有 `beginGoogleLogin`/`completeGoogleLogin`，但 routes `/google/start`、`/google/callback` 固定回 `404 GOOGLE_AUTH_DISABLED`（`packages/auth/src/express.ts:109-112`）。

#### (b) Passcode

- **現況**：`STUDENT_PASSCODE_LOGIN=true` 時啟用；否則 route 回 `404`（`packages/auth/src/express.ts:136`）。
- **雜湊**：scrypt `N=16384, r=8, p=1`、16-byte salt、32-byte key；格式 `scrypt$N$r$p$salt$key`（`packages/auth/src/passcode.ts:3-29`）。
- **Throttle**：每 IP 10 次 / 每帳號 5 次 / 15 分鐘；容量 10,000 keys（`packages/auth/src/passcode.ts:36-80`）。
- **登入**：`POST /api/student/auth/passcode/login` → origin guard → throttle → `verifyStudentPasscode` → 建/找 user → session（`packages/auth/src/express.ts:134-159`）。
- **錯誤**：格式錯誤/憑證錯 → `401 INVALID_CREDENTIALS`；throttle → `429 RATE_LIMITED` 或 `429 RATE_LIMITED_CAPACITY`。

#### (c) Student session

- Token：32 random bytes base64url；DB 只存 SHA-256 digest（`packages/auth/src/server.ts:164-166`、`:314-317`）。
- Cookie：`ai_student_session`，`HttpOnly`、`SameSite=Strict`、`Secure` 預設 true、`Max-Age=sessionTtlMs`（`packages/auth/src/server.ts:493-501`）。
- TTL：預設 8 小時（`packages/auth/src/server.ts:16`）。
- 撤銷：`revokeByTokenDigest`；logout 會清 cookie 並回 204（`packages/auth/src/server.ts:444-446`；`packages/auth/src/express.ts:167-174`）。

### 3.2 Admin 登入

| 項目 | 現況 | 證據 |
|---|---|---|
| 帳密 | `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH`；非 production 才允許 `ADMIN_PASSWORD` 明文 fallback | `apps/AI-adm-D1/src/server/ai/admin-auth.ts:45-72`、`:159-179` |
| 密碼雜湊 | scrypt `N=16384, r=8, p=1`、16-byte salt、32-byte derived；格式 `scrypt$N$r$p$salt$derived` | `admin-auth.ts:113-143` |
| Production fail-closed | 缺 username/hash 或 `ADMIN_SESSION_SECURE=false` → 啟動即 throw | `admin-auth.ts:64-72`；`apps/AI-adm-D1/src/server/index.ts:7-8` |
| 登入 throttle | 每 source 20 次 / 每帳號 5 次 / 15 分鐘 | `admin-auth.ts:16-18`、`:208-273` |
| Session | 32-byte token，DB 存 SHA-256 digest；`admin_sessions` 有 `csrf_token_digest` | `admin-auth.ts:275-305`；`packages/db/src/migrate.ts:294-305` |
| Cookie | `ai_admin_session` HttpOnly + `ai_admin_csrf` 非 HttpOnly；`SameSite=Strict`、`Secure` 預設 true | `admin-auth.ts:282-312` |
| CSRF | 只對 session 的 unsafe method；需 Origin 在 allowlist + header/cookie token 相同 + DB digest 驗證 | `admin-auth.ts:348-372` |
| Token auth | `ADMIN_API_TOKEN` 或 `Authorization: Bearer`；token client 不做 CSRF | `admin-auth.ts:84-110`、`:323-341` |
| Login audit | `admin.auth.login.succeeded/failed/throttled`、`admin.auth.logout` 寫入 `ai_admin_audit_logs` | `apps/AI-adm-D1/src/server/app.ts:374-417` |

### 3.3 401 / 403 / 404 對照

| 情境 | 回應 | 證據 |
|---|---|---|
| Admin 未帶 session/token | `401 {"error":"admin authentication required"}` | `admin-auth.ts:339` |
| Admin Origin 不在 allowlist | `403 {"error":"admin origin is not allowed"}` | `admin-origin.ts:24` |
| Admin session CSRF 缺 Origin | `403 {"error":"admin origin is required"}` | `admin-auth.ts:356-359` |
| Admin CSRF token 不符 | `403 {"error":"csrf validation failed"}` | `admin-auth.ts:361-367` |
| Admin 帳密錯誤 | `401 {"error":"invalid administrator credentials"}` | `app.ts:383-385` |
| Admin 登入 throttle | `429` + `Retry-After` | `app.ts:372-378` |
| Admin 未知 route | Express 預設 **HTML 404**（無 JSON envelope） | `app.ts` 無 catch-all；`grep -n "404" app.ts` 只有業務 404 |
| Student 無 session | `401 {"error":"AUTH_REQUIRED"}` 或 `SESSION_EXPIRED` | `packages/auth/src/express.ts:85-88` |
| Student profile 未完成 | `403 {"error":"PROFILE_INCOMPLETE"}` | `packages/auth/src/express.ts:89-92` |
| Student Origin 不允許 | `403 {"error":"STUDENT_ORIGIN_NOT_ALLOWED"}` | `packages/auth/src/express.ts:68-74` |
| Student Access token 無效 | `401 {"error":"ACCESS_ASSERTION_INVALID"}` | `packages/auth/src/express.ts:126-131` |
| Student passcode 停用 | `404`（空 body） | `packages/auth/src/express.ts:136` |
| Student 未知 book/file | `404 {"error":"book not found"}` / `{"error":"file not found"}` | `apps/AI-Stu-R1/server/stu-api.ts:179-260` |
| 未知 `/api/*` | Express 預設 **HTML 404** | Student/Admin 都沒有 API catch-all |

### 3.4 缺口與阻塞

| 缺口 | 影響 |
|---|---|
| Student `studentOriginAllowed` 在 `allowedOrigins` 為空時回 true，等於不限制 Origin | passcode login/logout/profile 的 CSRF 保護依賴 SameSite cookie；需要明確政策 |
| 未知 API route 回 HTML 404 | 客戶端無法用統一 envelope 判斷；與「安全錯誤格式」目標不一致 |
| Admin 沒有多角色/多租戶 | 無法表達教師、助教、學員的 scope isolation |
| Access email OTP 只在 Cloudflare 設定，repo 內沒有 IaC | 無法從程式碼驗證 OTP 政策；部署依賴外部設定 |

**阻塞**：Access 的 live 驗證需要 Cloudflare team domain/AUD 與憑證；repo 內沒有這些值，因此只能跑單元測試與 mock JWKS。

---

## 4. AI gateway、orchestration、provider、tool calling、credential loading

### 4.1 套件入口與責任

| 區域 | 現況 | 證據 |
|---|---|---|
| 舊版 provider | `createAiProvider`、`AiProvider.generateText`（給 book-core 等舊路徑） | `packages/ai/src/provider.ts`、`ai-client.ts` |
| Gateway | `AiGateway.run`：驗證 → 可用性 → route → fallback chain → retry/timeout → budget → log | `packages/ai/src/gateway/ai-gateway.ts:194-380` |
| Router | 依 subject/task/complexity 選 preferred + fallbacks + mock backstop | `packages/ai/src/gateway/ai-router.ts:143-220` |
| Providers | mock、Gemini、OpenAI、Kimi、Qwen、Zai | `packages/ai/src/gateway/providers/*.ts` |
| Credential-backed provider | 每次 request 從 DB 選 credential、輪替、cooldown、quota reserve | `apps/AI-adm-D1/src/server/ai/credential-provider.ts:27-200` |
| Budget | `BudgetManager` port；Admin 用 `DbBudgetManager`，另有 token pool | `packages/ai/src/gateway/ai-gateway.ts:26-79`；`apps/AI-adm-D1/src/server/ai/db-budget-manager.ts` |
| Prompt log | `PromptLogger` port；Admin 用 `DbPromptLogger`，diagnostics 經 allowlist | `apps/AI-adm-D1/src/server/ai/db-prompt-logger.ts`；`packages/ai/src/gateway/diagnostics-allowlist.ts` |
| Orchestration | `MultiModelOrchestrator`：token pool、context preflight、verification、adjudication、fusion、throttle tiers | `packages/ai/src/orchestration/multi-model-orchestrator.ts:102-400` |
| RAG | `RagApplicationService` + Cerebras adapter + citation/grounding/injection 檢查 | `packages/ai/src/rag/*`；`apps/AI-Stu-R1/server/student-rag.ts` |
| Evaluation | dataset/runner/scorers/live-control/governance | `packages/ai/src/evaluation/*` |

### 4.2 Credential loading

| 路徑 | 現況 | 證據 |
|---|---|---|
| Env static keys | `GEMINI_API_KEY`、`OPENAI_API_KEY`、`KIMI_API_KEY`、`QWEN_API_KEY`、`ZAI_API_KEY`；可覆寫 base URL/model | `packages/ai/src/gateway/gateway-config.ts:45-120` |
| DB vault | `ai_provider_credentials.encrypted_api_key`，AES-256-GCM envelope `v1.iv.tag.ciphertext`；master key 來自 `AI_CREDENTIAL_ENCRYPTION_KEY` | `apps/AI-adm-D1/src/server/ai/credential-crypto.ts:1-45` |
| 使用時機 | `CredentialBackedProvider` 在 request 時解密，只在記憶體中存在於 upstream call 期間 | `credential-provider.ts:1-160` |
| 啟停 | enable/disable/replace 立即生效，不需重啟 | `apps/AI-adm-D1/src/server/ai/gateway-instance.ts:20-55` |
| 驗證 | `credential.tested` audit、provider health、quota diagnosis | `app.ts:2519-2690` |

### 4.3 Tool calling

**現況：不存在。**

- `GatewayAiProvider` 只有 `providerId`、`defaultModel`、`diagnoseAvailability`、`isAvailable`、`generate`；沒有 `tools`、`tool_calls`、`function_call` 或 agent loop（`packages/ai/src/gateway/provider.interface.ts:14-45`）。
- `AiGenerateRequest`/`AiGenerateResult` 沒有 tool schema 欄位（`packages/ai/src/gateway/ai-types.ts`）。
- 全 repo 唯一提到 tool call 的地方是 pricing 註解：「Tool-call tokens are normalised by the provider adapter before reaching here」（`packages/ai/src/gateway/pricing.ts:430`），但沒有對應的 provider 實作。
- 因此目前**沒有**「模型呼叫工具 → 執行 → 回灌」的能力；也沒有 tool 權限/allowlist。

### 4.4 缺口與阻塞

| 缺口 | 證據 | 影響 |
|---|---|---|
| 沒有 tool calling | 上述 | 無法支援 Issue #17 未來的 tool-use 測試 |
| 沒有 streaming / SSE endpoint | `packages/ai/src/index.ts:50-53` 明確註解 guest-ask 為 atomic JSON，不要任意加 SSE | 串流需求需先設計 UTF-8/event boundary/abort |
| Mock fallback 在非 production 預設開啟 | `gateway-config.ts:62-68` | 測試可能拿到 mock 答案；production 需明確關閉 |
| Live provider smoke 需要真實 key | `scripts/provider-live-smoke.ts`；`release-gate:phase3a` 會 BLOCKED | 無法在無 secret 環境完整驗證 |
| Evaluation live 需 allowlist + 明確開啟 | `apps/AI-adm-D1/src/server/ai/live-evaluation-service.ts` | live evaluation 不是預設可用 |
| QM 不存在 | §9 | 無 QM workspace/feedback flow 可接 |

**阻塞**：live provider / live evaluation / QM 都需要外部憑證或不存在的外部系統；本 repo 只能提供 mock/fake 與 contract 測試。

---

## 5. Upload、PDF、教材、external URL 與 SSRF

### 5.1 Upload

| 類型 | 限制 | 儲存 | 證據 |
|---|---|---|---|
| Book file | 25 MiB + 1 byte（busboy 邊界），1 file、20 fields、22 parts | `uploads/books/.pending` → 成功後 rename | `app.ts:249-292`；`books-router.ts:108-185` |
| JSON index | 25 MiB + 1 byte，memory storage，1 file | 寫入 book 目錄 artifact | `app.ts:765`；`books-router.ts:362-408` |
| Appearance image | 2 MiB + 1 byte，memory storage，只允許 png/jpeg/webp | `uploads/appearance` | `app.ts:298-313`、`:3116-3135` |
| Reader TOC import | JSON body，Zod schema | 寫入 artifact | `books-router.ts:460-501` |
| PDF upload 驗證 | MIME 必須 `application/pdf`、檔名 `.pdf`、magic `%PDF-` |  | `app.ts:497-506` |
| Appearance 驗證 | raster signature 檢查；SVG 在 serve route 被 404 |  | `app.ts:320-332`、`:352-357`；`upload-security.integration.test.ts:66-141` |
| 檔名 | NFC、去路徑分隔、控制字元、特殊字元；空則 `upload.pdf` |  | `app.ts:237-246` |
| 失敗清理 | `removeUncommittedUpload`；不刪既有檔；log 不帶路徑 |  | `app.ts:252-276`、`:432-446` |

### 5.2 PDF / 教材

- 解析：`pdf-parse` v2 `PDFParse.getText()`，逐頁輸出；page number 必須是 1-based，否則 throw（`packages/book-core/src/pdf-parser.ts:16-70`）。
- 章節：outline / splitter / chapter-builder / summarizer（`packages/book-core/src/chapter-builder.ts`、`content-splitter.ts`、`book-splitter.ts`）。
- 教材資料：`books`、`book_files`、`book_contents`、`book_chapters`、`pdf_json_indexes`（檔案 artifact）、`reader_toc`（`packages/db/src/migrate.ts:6-52`；`books-router.ts`）。
- Student PDF 傳輸：`pdfSessions` in-memory map，8 小時 TTL；`/api/student/books/:bookId/files/:fileId/pdf-view`（`apps/AI-Stu-R1/server/stu-api.ts:34-37`、`:247-285`）。
- **缺口**：沒有病毒掃描、沒有 PDF sandbox、沒有頁數/解析時間上限（只有檔案大小）；`pdf-parse` 在 API 進程內同步/非同步解析，超大或惡意 PDF 可能拖慢進程。

### 5.3 External URL / SSRF

| 路徑 | 現況 | 證據 |
|---|---|---|
| 考情快照 crawler | 固定 origin `https://ec.ibrain.com.tw`；host allowlist `EXAM_COURSE_SOURCE_HOSTS_V1`；禁止 userinfo/port；手動 redirect 最多 5 次；每次 redirect 都重新驗證；最多 120 detail pages；80ms delay | `apps/AI-adm-D1/src/server/exam-snapshot/ibrain-url.ts:4-14`；`ibrain-crawl.ts:70-200` |
| RAG LLM base URL | `assertSafeLlmBaseUrl`：只允許 HTTPS、禁止 userinfo/query/hash、封鎖 localhost/private/link-local/metadata/obfuscated IP/punycode；`resolveSafeAddress` 做 DNS 解析並拒絕任何私網 IP；`pinnedFetch` 連線到已驗證 IP，關閉 DNS rebinding TOCTOU | `packages/ai/src/rag/safe-url.ts:28-200`；`packages/ai/src/rag/pinned-fetch.ts:22-90` |
| Cerebras adapter | 使用 `pinnedFetch`，不是原生 `fetch` | `packages/ai/src/rag/cerebras.adapter.ts:42-50`、`:128-230` |
| 一般教材 external URL import | **不存在**；沒有「貼 URL 抓教材」的 route | 全 repo 搜尋 `external URL`/`fetch(` 無對應 endpoint |
| `site/` outbound | `delegateToBackend` 只打 `PRIMARY_ORIGIN`；`relay-edge-gate` 控制 internal API | `site/app/api/backend-client.ts`；`site/lib/relay-edge-gate.ts` |

**缺口 / 阻塞**：
- 考情 crawler 依賴外部 ibrain 網站與 `DATABASE_URL`（Postgres snapshot store）；無網路/DB 時只能跑 fixture 測試（`admin-service.test.ts` 已用 fake）。
- 沒有通用 external URL ingestion，因此 Issue #17 的「external URL/SSRF fixture」目前只能測 RAG base URL 與 crawler，不能測教材 URL import。
- `safe-url` 的 DNS resolver 在 production 使用 `node:dns`；在 Workers/edge 環境不可用，因此只用於 Node RAG adapter。

---

## 6. DB schema、migration、seed、audit、測試資料生命週期

### 6.1 `packages/db`（主要 SQLite）

| 面向 | 現況 | 證據 |
|---|---|---|
| Driver | `better-sqlite3` + Drizzle ORM | `packages/db/src/client.ts:1-40`；`packages/db/package.json` |
| DB path | `SQLITE_PATH` 或 `data/ai-smartbook-r1.db` | `packages/db/src/client.ts`（`resolveDbPath`） |
| Schema | 手寫 SQL `STATEMENTS` + Drizzle schema 兩份 | `packages/db/src/migrate.ts:6-800`；`packages/db/src/schema.ts` |
| Migration | `runMigrations(sqlite)`：單一 transaction 執行所有 `CREATE TABLE IF NOT EXISTS`，再用 `addColumnIfMissing` 補欄位 | `packages/db/src/migrate.ts:1123-1266` |
| Student ownership（PR #146） | `smart_book_notes.student_id` 為 nullable，舊 row 留 NULL；`chat_sessions.user_id` 作為 session owner。notes 欄位以 idempotent column/index setup 加入，**沒有 backfill** | `packages/db/src/schema.ts:55-64,133-150`；`packages/db/src/migrate.ts:1133-1139` |
| 版本管理 | **沒有** `schema_version`/migration ledger；靠 idempotent SQL + `PRAGMA table_info` | `migrate.ts:823-840`、`:1123` |
| Rollback | **沒有** down migration | 同上 |
| Seed | `runSeed()`：demo book + 5+3 本 library fixture；以 title 冪等 | `packages/db/src/seed.ts:8-112` |
| Audit | `ai_admin_audit_logs`；`audit(action,targetType,targetId,metadata)`；metadata 只允許 allowlist key 的純量 | `packages/db/src/migrate.ts:286-293`；`repositories/aiProvider.repo.ts:41-46`、`:363-365` |
| Admin mutation audit | `POST/PUT/PATCH/DELETE` 完成後寫 `admin.request.mutation` | `apps/AI-adm-D1/src/server/admin-route-boundary.ts:27-39` |
| Retention | guest answer `expires_at` + `cleanupExpired`（每批 500）；session purge；evaluation retention jobs | `repositories/guestAskAnswer.repo.ts:76-102`；`adminSession.repo.ts:67`；`studentSession.repo.ts:48`；`ai-evaluation` routes |
| 測試資料 | 每個 integration test 用 `mkdtempSync` + 獨立 SQLite，`afterEach` `rmSync`；純 repo test 用 `:memory:` | `apps/AI-adm-D1/src/server/admin-api.integration.test.ts:23-44`；`packages/db/test/*` |

主要 table 群組：
- 書本/內容：`books`、`book_files`、`book_contents`、`book_chapters`、`pdf_access_logs`、`book_ai_jobs`、`book_qa_logs`、`smart_book_notes`
- 對話：`chat_sessions`、`chat_messages`
- AI：`ai_request_logs`、`ai_usage_logs`、`ai_provider_configs`、`ai_provider_credentials`、`ai_credential_model_quotas`、`ai_budget_policies`、`ai_daily_usage`、`ai_budget_reservations`、`ai_logical_models`、`ai_token_pools`、`ai_model_daily_limits`、`ai_token_pool_reservations`
- 訪客：`guest_ask_answers`
- 學員：`student_users`、`student_passcodes`、`student_sessions`、`student_learning_history`、`student_oauth_states`
- Admin：`admin_sessions`、`ai_admin_audit_logs`
- Evaluation/pilot：`ai_evaluation_*`、`ai_multi_model_pilot_*`

### 6.2 `site/`（D1 + R2）

| 面向 | 現況 | 證據 |
|---|---|---|
| Schema | Drizzle SQLite schema：`students`、`reading_progress`、`books`、`admin_overview`、`sync_runs`、`relay_nonces` 等 | `site/db/schema.ts:1-120` |
| Migration | `site/drizzle/0000..0003*.sql`；由 `drizzle-kit generate` 產生；**worker 不在 runtime 跑 migration** | `site/drizzle.config.ts`；`site/drizzle/*.sql` |
| Binding | `.openai/hosting.json` 宣告 `d1: "DB"`、`r2: "BOOKS_BUCKET"`；primary 站才有 binding | `site/.openai/hosting.json`；`site/deploy/targets.json` |
| DB access | `getDb()` 從 `cloudflare:workers` env 或 `globalThis.DB` 取得；缺 binding 丟 `D1UnavailableError` | `site/db/index.ts:18-52` |
| Seed | `fixtures/seed-d1.ts`、`seed-r2.ts`；資料 100% synthetic，有 provenance | `site/fixtures/generate.ts:1-100`；`site/fixtures/seed-d1.ts` |
| Fixture safety | `fixture:safety`：scan-fixture-safety、scan-secrets、verify-no-production-data | `site/package.json` scripts；`site/scripts/*.ts` |
| 測試 DB | `node:test` 用 `node:sqlite` `:memory:` 套用 drizzle SQL，並把 `globalThis.DB` 換成 D1-like adapter | `site/tests/sync-internal-api.test.mjs:30-60`；`site/tests/d1-persistence.test.mjs` |
| R2 | `InMemoryR2Bucket` 供測試；production 用 `BOOKS_BUCKET` | `site/lib/storage.ts:1-100` |

### 6.3 缺口與阻塞

| 缺口 | 影響 |
|---|---|
| 沒有 migration ledger/version/down migration | 無法判斷 DB 在哪一版；rollback 只能靠備份 |
| `migrate.ts` 同時維護 SQL 與 Drizzle schema | 兩份可能漂移；目前靠 `migration-regression.test.ts` 與 repo tests |
| 沒有 multi-instance 鎖 | SQLite 單檔；多個 API instance 同時 migrate/寫入需外部協調 |
| Site D1 migration 不在 worker runtime | 部署流程必須先套 SQL；漏套會回 `D1UnavailableError` 或查詢失敗 |
| 沒有 DB backup/restore 自動化 | 只有部署文件與外部 cron；repo 內無備份腳本 |
| 測試 DB 與 production schema 由同一份 SQL 建立 | 好處是一致；壞處是無法測「舊版 DB 升級」以外的歷史版本 |

**阻塞**：production DB 的實際版本與資料不在 repo；任何 migration 驗證只能在臨時 SQLite 上做。

---

## 7. 現有 unit、integration、contract、smoke、E2E scripts 與 gates

### 7.1 Root workspace 測試（Vitest）

| Package | Test files | Tests（最近一次全量） |
|---|---:|---:|
| `packages/schema` | 2 | 5 |
| `packages/contracts` | 3 | 23 |
| `packages/book-core` | 1 | 6 |
| `packages/db` | 16 | 191 |
| `packages/ai` | 54 | 811 |
| `packages/auth` | 7 | 48 |
| `apps/AI-Stu-R1` | 24 | 158 |
| `apps/AI-adm-D1` | 48 | 443 |
| **合計** | **155** | **1,685** |

- 證據：各 package `package.json` 的 `test: "vitest run"`；root `package.json` `test: "pnpm -r --if-present test"`。
- PR #146 驗證紀錄：155 files / 1,685 tests 全數通過；相較 PR #143 後基準新增 `student-isolation.integration.test.ts` 1 檔 / 6 項。
- `apps/AI-adm-D1` 的 `security-bundle.test.ts` 需要先 `build`；clean checkout 直接 `test` 會 fail-fast 並提示先 build（`apps/AI-adm-D1/src/security-bundle.test.ts:8-17`）。

### 7.2 測試類型分佈

| 類型 | 檔案數 / 代表 | 證據 |
|---|---|---|
| Unit / domain | `packages/ai/test/*`、`packages/book-core/test/*`、`packages/schema/test/*` | 各 package `test/` |
| Integration | 9 個 `*integration.test.ts*`：admin API、analytics、learning history、upload security、student auth/health/protected routes、app-router auth | `find apps packages -name "*integration.test.ts*"` |
| Contract | 7 個 `*contract.test.ts*`：AI quality、exam snapshots、evaluation API、phase5a pilot、server bundle、guest surface、postgres exam schema | `find apps packages -name "*contract.test.ts*"` |
| Repository / migration | 9 個 `*.repo.test.ts` / `*.migration.test.ts` | `packages/db/test/*` |
| Component / browser | React component、client boundary、security bundle、page title、route loading | `apps/*/src/**/*.test.tsx` |

### 7.3 `site/` 測試（Node `node:test`，不是 Vitest）

- 30 個 `site/tests/*.test.mjs`。
- `site/package.json` `test`：先 `npm run build`，再以 `node --import tsx --import ./tests/support/cloudflare-workers-shim.mjs --test --test-concurrency=1` 跑固定清單。
- 覆蓋：admin auth contract、D1 persistence、rendered HTML/cache isolation、API runtime、Chrome built-in AI、auto fallback、A-01 AGY、subject triage、fixture safety、auth hardening、shared backend、R2 storage、sync core/internal API、environment alignment/capture、sign-in、admin shell、runtime diagnostics、three-site topology、relay（canonical/sign/verify/secondary/logging/edge gate）、site build env。
- 證據：`site/package.json` scripts；`site/tests/*.test.mjs`。

### 7.4 Smoke / E2E / gates（scripts）

| 類型 | 指令 / 檔案 | 用途 | 證據 |
|---|---|---|---|
| DB preflight | `pnpm db:preflight:phase2` | 檢查 SQLite schema/連線 | `scripts/phase2-db-preflight.ts` |
| HTTP smoke | `pnpm smoke:phase2`、`pnpm smoke:phase3a` | 本機/staging API 煙霧測試 | `scripts/phase2-http-smoke.ts`、`phase3a-staging-smoke.ts` |
| Provider live | `pnpm smoke:provider` | 真實 provider（需 key） | `scripts/provider-live-smoke.ts` |
| Student auth smoke | `pnpm student:auth-smoke` | 學員登入流程 | `scripts/student-auth-smoke.ts`、`student-smoke-harness.ts` |
| Student dashboard smoke | `pnpm student:dashboard-smoke` | 學員 dashboard | `scripts/student-dashboard-smoke.ts` |
| RAG smoke | `pnpm rag:smoke` | RAG grounded/錯誤模式 | `scripts/rag-smoke.ts` |
| Guest ask live | `pnpm verify:guest-ask-live` | 訪客問答 live | `scripts/guest-ask-live-verify.ts` |
| Admin UI E2E | `pnpm e2e:admin-providers` | Playwright/provider UI | `scripts/admin-provider-ui-e2e.mjs` |
| Production verify | `pnpm production:verify:phase3a` | production 唯讀驗證 | `scripts/production-verification.mjs` |
| Release gate | `pnpm release-gate:phase3a` | 串接 typecheck/lint/test/build/preflight/rotation/E2E/staging/provider/production | `scripts/phase3a-release-gate.mjs:60-120` |
| Credential rotation | `pnpm credential-key:rotate` / `verify` | 金鑰輪替 | `scripts/credential-key-rotation.ts` |
| Boundary | `bash scripts/boundary-check.sh` | browser/server 與 package 邊界 | `scripts/boundary-check.sh` |
| Contracts | `pnpm contracts:validate` | contracts export + test | `package.json`；`scripts/contracts-boundary.mjs` |
| Site preflight | `pnpm site:preflight` | site target/project_id/role | `site/scripts/verify-site-target.mjs` |
| Site env alignment | `pnpm environment:align` | 與 control-plane manifest 比對 | `site/scripts/verify-environment-alignment.mjs` |
| Site fixture safety | `pnpm fixture:safety` | 掃 synthetic/secret/production data | `site/scripts/scan-fixture-safety.ts`、`scan-secrets.ts`、`verify-no-production-data.ts` |
| Site package size | `pnpm package:size-gate` | 上傳包大小 | `site/scripts/verify-upload-package-size.mjs` |
| Browser QA | `node site/scripts/run-real-browser-qa.mjs`、`run-chrome-e2e-suite.mjs` | 真瀏覽器/Chrome 內建 AI | `site/scripts/*` |
| Nightly PM round | `node scripts/a01-nightly-round.mjs` | Slack 夜間彙報（dry-run 預設） | `scripts/a01-nightly-round.mjs`；`deploy/cron/a01-nightly-round.cron` |

### 7.5 CI / gate 現況

- **沒有 `.github/workflows/`**；`.github/` 只有 `CODEOWNERS`。因此上述 gates 目前是**手動/local script**，不是 PR 強制檢查。
- `release-gate:phase3a` 會把缺少 secret 的 provider/rotation 標成 `BLOCKED`，不是 `PASS`（`scripts/release-gate-core.mjs:8-40`）。
- `site/` 不在 `pnpm-workspace.yaml`，root `pnpm test` **不會**跑 site tests。

### 7.6 缺口與阻塞

| 缺口 | 影響 |
|---|---|
| 無 GitHub Actions / CI workflow | 沒有自動 PR gate；只能靠人工跑 release gate |
| Site tests 不在 root test | 兩個測試生態（Vitest vs node:test）需分別維護 |
| Admin bundle security test 依賴 build 產物 | clean checkout 的 `pnpm test` 會 fail，需先 build |
| Live provider/rotation gates 需要 secret | 無 secret 時永遠 BLOCKED |
| 沒有 coverage threshold | 無法防止測試數量/覆蓋率退化 |

**阻塞**：CI 自動化需要 repo 權限與 workflow 設計；live gates 需要外部 secret；兩者都不在本次唯讀盤點範圍。

---

## 8. Port、環境變數、啟動順序、測試隔離與 cleanup

### 8.1 Ports

| 服務 | Port | 證據 |
|---|---:|---|
| Admin API | 4300 | `apps/AI-adm-D1/src/server/index.ts:14`；`reset-ai-smartbook.sh:53` |
| Student API | 4310 | `packages/student-runtime/src/config.ts:23`；`reset-ai-smartbook.sh:54` |
| Admin web (Vite) | 5174 | `apps/AI-adm-D1/package.json` `dev`；`reset-ai-smartbook.sh:55` |
| Student web (Vite) | 5173 | `apps/AI-Stu-R1/package.json` `dev`；`reset-ai-smartbook.sh:56` |
| Site local QA server | 3002（只綁 127.0.0.1） | `site/scripts/local-qa-server.mjs:71`、`:123` |
| B3 exam search sidecar | 4360 | `deploy/README.md`；`deploy/systemd/b3-search-api.service` |

> `site/` 的 `npm run dev` port 由 vinext 決定，repo 沒有固定；本機可重現的入口是 `local-qa-server.mjs` 的 3002。

### 8.2 環境變數（分組）

| 群組 | 變數 |
|---|---|
| Admin auth | `ADMIN_USERNAME`、`ADMIN_PASSWORD`（非 prod fallback）、`ADMIN_PASSWORD_HASH`、`ADMIN_API_TOKEN`、`ADMIN_SESSION_COOKIE`、`ADMIN_SESSION_SECURE`、`ADMIN_SESSION_TTL_MS`、`ADMIN_ALLOWED_ORIGINS` |
| Admin runtime | `NODE_ENV`、`ADMIN_API_HOST`、`ADMIN_API_PORT`、`SQLITE_PATH`、`UPLOAD_DIR`、`AI_CREDENTIAL_ENCRYPTION_KEY`、`GUEST_ASK_IP_HMAC_SECRET`、`GUEST_ASK_RETENTION_DAYS` |
| Student auth | `STUDENT_ACCESS_TEAM_DOMAIN`、`STUDENT_ACCESS_AUD`、`STUDENT_ACCESS_CERTS_URL`（非 prod test）、`STUDENT_SESSION_SECRET`/`SESSION_SECRET`、`STUDENT_SESSION_TTL_MS`、`STUDENT_SESSION_COOKIE`、`STUDENT_SESSION_SECURE`、`STUDENT_ALLOWED_ORIGINS`、`STUDENT_PASSCODE_LOGIN`、`STUDENT_AUTH_DB_PATH` |
| Student runtime | `STU_RUNTIME_MODE`（`static`/`sqlite-api`/`remote-api`）、`STU_DB_PATH`、`STU_API_PORT`、`STU_PUBLIC_DIR`、`STU_READONLY_MODE`、`STU_CHAT_MODE`、`STU_UPLOAD_DIR`、`STU_REMOTE_API_BASE_URL` |
| AI gateway | `AI_GATEWAY_ENABLED`、`AI_DEFAULT_PROVIDER`、`AI_ROUTER_PROVIDER`、`AI_REQUEST_TIMEOUT_MS`、`AI_MAX_RETRIES`、`AI_MAX_INPUT_CHARS`、`AI_MAX_OUTPUT_TOKENS`、`AI_DAILY_COST_LIMIT_USD`、`AI_DAILY_TOKEN_LIMIT`、`AI_BUDGET_WARNING_PERCENTAGE`、`AI_ALLOW_MOCK_FALLBACK`、`AI_MOCK_MODEL` |
| Providers | `GEMINI_API_KEY`/`MODEL`、`OPENAI_API_KEY`/`MODEL`/`BASE_URL`、`KIMI_*`、`QWEN_*`、`ZAI_*` |
| RAG | `STUDENT_RAG_PROVIDER`、`STUDENT_RAG_FAKE_MODE`、`CEREBRAS_API_KEY`、`CEREBRAS_BASE_URL`、`CEREBRAS_MODEL` |
| Exam snapshot | `DATABASE_URL`、`EXAM_DB_CONNECT_TIMEOUT_MS`、`EXAM_POSTGRES_DRIVER`、`EXAM_SNAPSHOT_DELAY_MS`、`EXAM_SNAPSHOT_MAX_DETAIL_PAGES` |
| Site / relay | `ADMIN_EMAILS`、`A01_SYNTHETIC_ACCOUNTS`、`A01_RELAY_MODE`、`A01_RELAY_SITE`、`A01_RELAY_SIGNING_KEY`、`A01_RELAY_KEY_STUDENT/ADMIN(_PREV)`、`A01_RELAY_EDGE_MODE`、`A01_RELAY_EDGE_SECRET_STUDENT/ADMIN(_PREV)`、`RELEASE_VALIDATION_SECRET`、`SYNC_IMPORT_SECRET`、`SYNC_MAX_PDF_BYTES`、`SITE_ROLE`、`SITE_NAME`、`PRIMARY_ORIGIN`、`GIT_SHA` |
| Google（目前停用） | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REDIRECT_URI`、`GOOGLE_AUTHORIZATION_ENDPOINT`、`GOOGLE_TOKEN_ENDPOINT`、`GOOGLE_USERINFO_ENDPOINT` |

證據：`deploy/systemd/admin.env.example`、`deploy/systemd/student.env.example`、`apps/AI-adm-D1/src/server/env.ts`、`packages/auth/src/server.ts:117-160`、`packages/student-runtime/src/config.ts:18-29`、`packages/ai/src/gateway/gateway-config.ts:45-120`、`site/worker/index.ts:7-38`。

### 8.3 啟動順序

`reset-ai-smartbook.sh` 的順序（`reset-ai-smartbook.sh:397`）：

1. `admin-api`（4300）：先確認 `.env` 有 `ADMIN_API_TOKEN` 與 `AI_CREDENTIAL_ENCRYPTION_KEY`；啟動後檢查 `/health/live`、`/health/ready`、未認證 `/api/admin/accounts` 應 401、帶 token 應 200。
2. `student-api`（4310）。
3. `admin-web`（5174）：Vite dev proxy → Admin API；會做 full-login 或 unauthenticated proxy probe。
4. `student-web`（5173）：`STUDENT_API_TARGET=http://127.0.0.1:4310`。

Production 則由 systemd + nginx 啟動：`deploy/systemd/ai-adm-d1.service`、`ai-stu-r1.service`；Admin/Student 分機，Student 1GB 機器限制見 `deploy/README.md`。

### 8.4 測試隔離與 cleanup

| 機制 | 現況 | 證據 |
|---|---|---|
| Admin/Student integration | `mkdtempSync(tmpdir())` 建獨立 SQLite；`afterEach` `rmSync`；`finally` `sqlite.close()` | `admin-api.integration.test.ts:17-44`；`learning-history.integration.test.ts` |
| DB repo tests | `:memory:` SQLite，每個 test 重建 schema | `packages/db/test/*` |
| Site tests | `node:sqlite` `:memory:` + D1-like adapter；`InMemoryR2Bucket`；`--test-concurrency=1` | `site/tests/sync-internal-api.test.mjs:30-60`；`site/lib/storage.ts` |
| Cloudflare shim | `register()` + hooks 把 `cloudflare:workers` 導到 `data:` module；避免 Node 直接 import 失敗 | `site/tests/support/cloudflare-workers-shim.mjs`；`site/scripts/cloudflare-workers-hooks.mjs` |
| Port 清理 | `stop_service` 先 TERM process group，再 KILL，必要時 `fuser -k`/`lsof` 清 port | `reset-ai-smartbook.sh:270-330` |
| Artifact 清理 | `release-artifacts.mjs` 寫 sanitized artifact；`RELEASE_GATE_REPORT_PATH` 可覆寫 | `scripts/release-artifacts.mjs` |
| Fixture 安全 | `fixture:safety` 掃 secret、synthetic provenance、production data | `site/package.json`；`site/scripts/*.ts` |

### 8.5 缺口與阻塞

| 缺口 | 影響 |
|---|---|
| `reset-ai-smartbook.sh` 會 `kill_port` 佔用 4300/4310/5173/5174 的任意 process | 可能殺掉非本專案進程；不是 container/namespace 隔離 |
| `TRUST_PROXY` 已不再影響 client IP，只警告 | 舊部署若依賴它，IP 判斷會改變（`app.ts:148`；`docs/ADMIN_AUTH_DEPLOYMENT.md`） |
| 沒有 `.env.test.example` 或 test env doctor | Issue #17 要求的隔離測試環境尚未建立 |
| 沒有 CI runner 的 port/DB 隔離 | 只能本機手動跑 |
| `site/` 與 root 的 Node 版本/測試 runner 不同 | 需兩個 bootstrap（pnpm vs npm；Vitest vs node:test） |

**阻塞**：要在 CI 重現，需要先決定 workflow 與 secrets；目前 repo 沒有 CI 定義。

---

## 9. QM adapter 現況

**現況：不存在。**

- `docs/MODULE_OWNERSHIP.md:24` 明確記載：
  > 「No standalone adapter exists on `main`; future adapter must expose a declared port. `deploy/qm` is deployment-only」
- `docs/MODULE_OWNERSHIP.md:68` 再次列為 known baseline gap：
  > 「No standalone QM adapter exists in `main`; ownership and required boundary are defined before such code is introduced.」
- 實際搜尋 repo：沒有任何 `qm` 目錄/模組/route；`deploy/qm` 也不存在（與文件描述的「deployment-only」不一致，需另票確認）。
- 因此：
  - **沒有 QM workspace**
  - **沒有 QM feedback flow**
  - **沒有 QM mock/local integration**
  - 現有的 `/api/public/guest-feedback` 只是訪客問答的 acknowledgement（`app.ts:2121-2127`），與 QM 無關。
- 未來若要做 QM，依 ownership 文件必須：暴露 declared port、不得讓 browser import vendored QM internals、provider secrets 不得進 DTO、測試不得改 deployment。

**阻塞**：QM 功能與介面不存在，任何 QM 相關測試/fixture 目前只能標「不存在」，不能推測。

---

## 10. 未解缺口與阻塞總表

| # | 缺口 | 嚴重度 | 證據 | 阻塞 / 下一步 |
|---|---|---|---|---|
| G3 | 未知 `/api/*` 回 HTML 404 | 中 | §3.3 | 需定義 JSON 404 envelope |
| G4 | 沒有 QM adapter / workspace / feedback | 高（對 #17） | §9 | 不存在，不能推測 |
| G5 | 沒有 tool calling | 高（對 AI 能力） | §4.3 | 需 provider interface 與 policy 設計 |
| G6 | 沒有 GitHub Actions CI | 高（對品質 gate） | `.github/` 只有 CODEOWNERS | 需 workflow 與 secrets |
| G7 | `site/` 測試不在 root `pnpm test` | 中 | §7.5 | 需 CI 或 root script 整合 |
| G8 | 沒有 migration ledger/down migration | 中 | §6.1 | 需 schema version 策略 |
| G9 | 沒有 `.env.test.example` / env doctor | 中（對 #17） | §8.5 | 子票 #22/#23 應補 |
| G10 | `reset-ai-smartbook.sh` 以 port kill 清理 | 中 | §8.5 | 需 container/namespace 或 pid 驗證 |
| G11 | `deploy/qm` 文件與實際不一致 | 低 | §9 | 文件修正或補目錄 |
| G12 | 沒有病毒掃描 / PDF sandbox | 中 | §5.2 | 需外部掃描或隔離 worker |
| G13 | Live provider/rotation gates 需 secret | 中 | §7.5 | 無 secret 時 BLOCKED |
| G14 | Student origin 在 allowlist 空時不限制 | 中 | §3.4 | 需明確 production 政策 |
| G15 | Admin 單一角色，無 tenant/role | 中（對 #17 fixtures） | §2.4 | 需先定義角色模型 |
| G16 | PR #145 安全文件仍標記 G1/G2 尚未合併 | 低（文件漂移） | `docs/security/THREAT_MODEL.md:52,56,89-90,106`；`ATTACK_CASES.md:12,53`；`SECURITY_ACCEPTANCE_MATRIX.md:24,43,70-71` | 在後續文件修正票將威脅模型、AC-04 與 acceptance/backlog 對齊 PR #146；本票不改安全文件 |

**已解除（PR #146，`0562850`）**：G1 Student notes 改由已驗證 Student owner 隔離；G2 chat/progress/session 對 owner 作 server-side 檢查。跨 owner note 操作與舊 session 存取 fail-closed；舊 notes list 隱藏 NULL-owner rows、note PATCH/DELETE 與 session 存取回 404。資料保留、不回填、不刪除。回歸證據為 `apps/AI-adm-D1/src/server/student-isolation.integration.test.ts`（6 項）。教師、班級與課程 policy 仍是獨立未解範圍。

---

## 11. 證據索引（快速跳轉）

| 主題 | 主要檔案 |
|---|---|
| 套件邊界 | `docs/MODULE_OWNERSHIP.md`、`scripts/boundary-check.sh`、`scripts/contracts-boundary.mjs`、`packages/*/package.json` |
| Admin app / routes | `apps/AI-adm-D1/src/server/app.ts`、`books-router.ts`、`accounts-router.ts`、`student-passcodes-router.ts`、`student-questions-router.ts`、`learning-history-router.ts`、`ai-analytics-router.ts`、`ai-evaluations-router.ts`、`exam-snapshot/admin-router.ts` |
| Student app / routes | `apps/AI-Stu-R1/server/stu-api.ts`、`student-rag.ts`、`health-routes.ts`、`packages/auth/src/express.ts`、`learning-history-express.ts` |
| Admin auth | `apps/AI-adm-D1/src/server/ai/admin-auth.ts`、`admin-origin.ts`、`admin-route-boundary.ts`、`docs/ADMIN_AUTH_DEPLOYMENT.md` |
| Student auth | `packages/auth/src/access.ts`、`passcode.ts`、`server.ts`、`express.ts` |
| Security baseline（PR #145；G1/G2 敘述待更新） | `docs/security/THREAT_MODEL.md:52,56,89-90,106`；`docs/security/ATTACK_CASES.md:12,53`；`docs/security/SECURITY_ACCEPTANCE_MATRIX.md:24,43,70-71` |
| Student ownership isolation（PR #146） | `apps/AI-adm-D1/src/server/student-books-router.ts:207-270,323-363,417-453`；`apps/AI-adm-D1/src/server/app.ts:1596-1652`；`packages/db/src/schema.ts:55-64,133-150`；`packages/db/src/migrate.ts:1133-1139`；`apps/AI-adm-D1/src/server/student-isolation.integration.test.ts:60-220` |
| AI gateway | `packages/ai/src/gateway/*`、`apps/AI-adm-D1/src/server/ai/gateway-instance.ts`、`credential-provider.ts`、`credential-crypto.ts` |
| Orchestration | `packages/ai/src/orchestration/*` |
| RAG / SSRF | `packages/ai/src/rag/*`、`apps/AI-Stu-R1/server/student-rag.ts` |
| Upload / PDF | `apps/AI-adm-D1/src/server/app.ts`、`books-router.ts`、`packages/book-core/src/pdf-parser.ts` |
| DB | `packages/db/src/{schema,migrate,seed,client}.ts`、`packages/db/src/repositories/*` |
| Site | `site/worker/index.ts`、`site/app/api/*`、`site/db/*`、`site/drizzle/*`、`site/fixtures/*`、`site/lib/*` |
| Tests / gates | 各 package `test/`、`site/tests/*`、`scripts/*`、`deploy/*`、`.github/CODEOWNERS` |
| Startup / env | `reset-ai-smartbook.sh`、`deploy/systemd/*`、`deploy/nginx/*`、`deploy/README.md` |
