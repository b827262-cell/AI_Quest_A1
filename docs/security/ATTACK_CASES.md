# 安全攻擊案例（現行 main）

本文件供後續 Codex／reviewer 在本機、throwaway DB、合成使用者與 fake provider 上重現。不得使用正式帳號、正式 token、真實教材或 production endpoint；不得放入可被 release script 執行的 exploit payload。所有案例的「現況」只指可由引用程式／測試確認的部分。

優先度：P1 表示可能影響身份、授權、敏感資料或上線邊界，需在相關路徑擴大使用前關閉或由 Owner 接受；P2 表示有界的可用性、監控或驗收缺口，需列入追蹤；N/A 表示功能不在 current main，不代表通過安全驗收。

| ID | 案例 | 優先度 | 目前狀態 | 建議自動化層級 |
|---|---|---:|---|---|
| AC-01 | 未授權、偽造與過期登入憑證 | P1 | 已測主要登入與 session 閘門 | HTTP integration + Student auth smoke |
| AC-02 | Session replay、替換、登出競態 | P1 | replay/expiry/revoke 已測；在途 race 與完整 refresh 語意有缺口 | HTTP integration；race 需 barrier-controlled 測試 |
| AC-03 | 多個並行 401 造成事件風暴 | P2 | 缺明確並行 UI 驗收 | UI integration + fake timer |
| AC-04 | IDOR／跨學員、班級、課程、教材 | P1 | RAG book/student scope 有測；G1 notes 未按 studentId 隔離、G2 chat/progress client session 未驗證 owner，狀態：目前缺口（PR #146 修補中，尚未合併 main）；teacher/class/course policy 未證明 | HTTP integration：synthetic A/B 學員對 notes CRUD、chat 與 progress 做負向測試 |
| AC-05 | Role／權限提升 | P1 | Admin app/allowlist 有測；Sites 平台 identity stripping 未實測 | HTTP + relay unit/integration；平台 staging manual gate |
| AC-06 | 404/403 業務錯誤被當成 401 | P2 | 主要 Student/RAG 分類有測；全 client 覆蓋不足 | HTTP + UI component integration |
| AC-07 | Prompt injection、間接注入、tool abuse | P1 | query filter / grounding 有測；間接注入為殘餘風險；無現行任意工具路徑 | AI unit/application integration + fake provider |
| AC-08 | 惡意教材/PDF 指令或解析器 DoS | P1 | upload MIME/大小/簽章有測；解析沙箱與間接注入未證明 | Upload/parser integration；sandbox/resource review |
| AC-09 | QM scope、memory、file、keychain、run trace 洩漏 | N/A* | main 沒有 QM adapter；不是現行可執行路由 | 新 adapter 時 contract + tenant A/B integration；目前 N/A |
| AC-10 | Secret 出現在 bundle、log、error、Git、artifact | P1 | bundle boundary / redaction / 部分安全錯誤有測；全域 Git/artifact scan 缺口 | Browser build + API/log integration + tracked-source/artifact scans |
| AC-11 | Upload path traversal、MIME spoof、oversize、malformed document | P1 | MIME、signature、大小、失敗清理有測；path traversal 明確負向測試缺口 | HTTP multipart integration + temporary upload root |
| AC-12 | SSRF／unsafe URL fetch／內網探測 | P1 | Cerebras adapter URL/DNS/redirect guard 有 adversarial tests；Admin 可設定的通用 provider base URL 與直接 fetch 尚未共用這層保護 | Unit + adapter integration with fake DNS/transport |
| AC-13 | Audit 缺漏、竄改或過度記錄 | P2 | Admin audit/allowlist 有測；防竄改、留存與全面性未證明 | DB/API integration + operations retention review |
| AC-14 | Dependency、install script、CI/release supply-chain | P2 | lockfiles/boundary/release scripts 存在；未找到 workflow 自動化安全掃描證據 | Static lockfile review + frozen install/audit + release-gate |

## AC-01 — 未授權、偽造與過期憑證

- **前置條件：** 本機 Student test app + generated RSA/JWKS fixture、throwaway DB；使用合成資料。
- **重現：** 對 `/api/student/auth/access/login` 依序送缺失 assertion、錯簽名、過期、未來 nbf、錯 kid/aud/issuer assertion；再以無 cookie／隨機 cookie 呼叫 `/api/student/books`。不要呼叫真實 Access。
- **預期：** assertion/session 無效為 401，不建立 session cookie；Access 設定或憑證來源不可用才回 503；protected route 不回資料。一般 403 profile gate 不得偽裝成 401。
- **main 現況：** 已測上述 assertion 類型及 session gate；Access email header、`CF_Authorization`、`oai-*` 不可取代 signed JWT。**PASS（本機測試範圍）**。
- **證據／自動化：** `packages/auth/src/access.ts`; `packages/auth/src/express.ts`; `apps/AI-Stu-R1/server/student-auth-routes.integration.test.ts`; `apps/AI-Stu-R1/server/student-protected-routes.integration.test.ts`; `scripts/student-auth-smoke.ts`。用 integration + smoke；只用 generated keys。

## AC-02 — Session replay、替換與 logout race

- **前置條件：** 兩個合成學生 session、Admin session、throwaway DB。
- **重現：** (1) 把 A 的 session cookie 放到 B 的 client；(2) 用 student cookie 存取 Admin route，或把 Student cookie 名稱替換成 Admin cookie 名稱；(3) 用已 logout／過期 session 重播；(4) 在兩條本機請求中同時送 logout 與受保護 mutation，觀察在途請求語意。沒有 refresh token endpoint；不要假設存在 refresh-token flow。
- **預期：** session 只能代表被簽發 actor；Admin/Student session 不能互換；已撤銷/過期 cookie 401。logout 完成後後續請求拒絕；已經通過 middleware 的同時在途請求應明確記錄其競態語意。
- **main 現況：** Student/Admin repo 只存 token digest、到期與 revoke 狀態；Student logout replay 與 Admin revoked/expired 有測試。對在途 logout race 沒找到明確測試，因此 **PARTIAL**。
- **證據／自動化：** `packages/db/src/repositories/studentSession.repo.ts`; `packages/db/src/repositories/adminSession.repo.ts`; `apps/AI-Stu-R1/server/student-protected-routes.integration.test.ts`; `apps/AI-adm-D1/src/server/admin-api.integration.test.ts`; `packages/auth/src/express.ts`。補兩請求 barrier-controlled integration test。

## AC-03 — 並行 401 事件風暴

- **前置條件：** Student UI integration harness 與本機 API；一個過期 session。
- **重現：** 登入後讓 session 過期，一次並行觸發多個需要 session 的 API，記錄 redirect、logout 呼叫及錯誤訊息數。
- **預期：** 401 只清除／重導一次，不重複建立登入流程或產生無界重試；403/404/5xx 不應因此清除登入狀態。
- **main 現況：** React auth provider 有 `/me` refresh 與明確 logout；頁面測試涵蓋到期後回 login，但未找到多 endpoint 同時 401 的事件風暴測試。**GAP**。
- **證據／自動化：** `apps/AI-Stu-R1/src/student-auth.tsx`; `apps/AI-Stu-R1/src/App.tsx`; `apps/AI-Stu-R1/src/app-router.auth.integration.test.tsx`。補 fake timer + concurrent requests UI/integration test。

## AC-04 — IDOR／跨學員、班級、課程或教材

- **前置條件：** 兩個合成 student、synthetic book、throwaway DB；以 A/B 帳號隔離測試資料，不使用正式資料。
- **重現：** (1) 驗證 RAG body 不能覆寫 `studentId`/scope。(2) A 建立筆記後，以 B 讀取同一本書的 notes 並嘗試修改/刪除 A 的 note。(3) A 建立 chat/session 與 progress 後，以 B 提交 A 的 book-session key：chat 透過 body `sessionId`，progress 透過 `x-student-session-id`；檢查是否取得或改動 A 的資料。(4) 僅在實際存在的 API 測跨 book 資源關係，不臆造班級/課程 endpoint。
- **預期：** Student RAG 由已驗證 server session + route book 建立 scope；notes、chat、progress 也必須綁定目前 Student owner。跨 owner 讀寫應以 documented 403/404 拒絕，且不回傳對方資料；缺少 owner 不得被視為可共享。
- **main 現況：** Student RAG 拒絕 body scope override，並有 cross-book/unknown-book/scoped retrieval 測試。G1：notes 目前按 published book/note 關係操作，沒有 studentId 所有權維度。G2：chat body sessionId、progress `x-student-session-id` 會選定 book-session，現有檢查沒有驗證它屬於目前 Student owner。G1/G2 狀態：**目前缺口（PR #146 修補中，尚未合併 main）**。Teacher/class/course policy 仍未證明。
- **證據／自動化：** `apps/AI-Stu-R1/server/student-rag.ts`; `apps/AI-Stu-R1/server/student-protected-routes.integration.test.ts`; `packages/ai/test/rag/scope.test.ts`; `apps/AI-adm-D1/src/server/student-books-router.ts`; `apps/AI-adm-D1/src/server/app.ts`; `packages/db/src/repositories/smartBookNote.repo.ts`; `packages/db/src/repositories/chat.repo.ts`; `packages/db/src/schema.ts`; `apps/AI-Stu-R1/src/studentClient.ts`; `packages/contracts/src/identity.ts`。補以兩個 Student principal 執行 notes CRUD、chat session 與 progress 的 HTTP negative integration tests。

## AC-05 — Role／權限提升

- **前置條件：** throwaway Admin DB/config；Sites relay 用 fake secret、fake identities。
- **重現：** (1) Student cookie 或匿名請求呼叫 `/api/admin/*`; (2) 加入 `oai-authenticated-user-role: admin` 或非 allowlisted email；(3) 在 Site relay test 用 forged `oai-*` header 走 secondary→primary；平台行為只可用 staging 依 Owner 許可的安全測試，不在此票執行。
- **預期：** Admin route 需要 Admin session 或限定的內部 bearer token；unsafe session mutation 需 origin + CSRF；sites admin 僅 allowlist 精確 email；外部偽造 identity 不得經平台進入簽章流程。相同 signed relay GET 在時間窗內應不被用來重播敏感讀取，或文件化其可重播風險。
- **main 現況：** Admin boundary、CSRF、學生 cookie 拒絕及 allowlist 的程式測試存在；`oai-authenticated-user-role` 不授予 admin。relay HMAC/edge gate 有單元測試，但 Sites 是否清除 inbound `oai-*` 仍是 runbook O-1a **未驗證的上線閘門**；如果平台不清除，secondary 會替 forged `oai-*` 簽章。Relay verifier 對非 GET/HEAD 寫入 nonce 防重播，GET/HEAD 僅受 300 秒 timestamp 視窗保護。**PARTIAL / P1-P2**。
- **證據／自動化：** `apps/AI-adm-D1/src/server/admin-route-boundary.ts`; `apps/AI-adm-D1/src/server/admin-api.integration.test.ts`; `site/app/api/auth-helper.ts`; `site/lib/relay-signature.ts`; `site/lib/relay-edge-gate.ts`; `site/tests/relay-secondary.test.mjs`; `site/tests/relay-edge-gate.test.mjs`; `docs/ops/three-site-runbook.md`。

## AC-06 — 業務 403/404 被當成 authentication failure

- **前置條件：** 本機 Student UI + API，準備 profile incomplete、missing book、expired session、provider unavailable 等不同 fixture。
- **重現：** 分別呼叫需要登入但 profile incomplete、未知 book、過期 session、RAG provider failure；觀察 HTTP status、錯誤 envelope、router 狀態。
- **預期：** 401 = 未登入/無效 session；403 = 已登入但 profile/policy 不允許；404 = 未知或不可見資源；5xx = infrastructure/provider。前端不得將所有非 2xx 一律登出。
- **main 現況：** API 與 RAG UI 對主要狀態有分流；無證據顯示每個 API client 都統一驗收所有狀態的行為。**PARTIAL**。
- **證據／自動化：** `packages/auth/src/express.ts`; `apps/AI-Stu-R1/server/student-auth-routes.integration.test.ts`; `apps/AI-Stu-R1/server/student-protected-routes.integration.test.ts`; `apps/AI-Stu-R1/src/components/BookRagPanel.tsx`; `packages/ai/src/rag/errors.ts`。

## AC-07 — Prompt injection、indirect injection 與 tool abuse

- **前置條件：** fake provider、合成教材片段；不使用外部 provider 或會執行指令的 payload。
- **重現：** (1) 對 query screening 測試送安全的 injection fixture；(2) 將無害的「忽略先前指示」文字置入合成教材片段，檢視 retrieval/generation 是否把它當作不可信內容；(3) 確認 RAG/provider request contract 沒有暴露任意工具執行介面。
- **預期：** 已知 query injection 被拒絕；模型輸出須受 scope、citation、claim grounding 驗證；教材指令不可提升權限或呼叫任意工具；對無法證明的輸出採 abstain/unverified。
- **main 現況：** query filter、scope、citation/grounding 有測；文件明確說明 prompt screen 是 deterrent 並只判斷 query，不是語意安全證明。現行 RAG provider port 只傳 generation 輸入，未見任意 tool invocation contract；indirect injection 沒有完整防護證明。**PARTIAL / P1**。
- **證據／自動化：** `packages/ai/src/rag/injection-screening.ts`; `packages/ai/src/rag/application.ts`; `packages/ai/src/rag/ports.ts`; `packages/ai/src/rag/citation-validator.ts`; `packages/ai/src/rag/grounding-validator.ts`; `packages/ai/test/rag/injection-screening.test.ts`; `packages/ai/test/rag/claim-integrity.test.ts`; `docs/STUDENT_AUTH_RAG_OPERATIONS.md`。

## AC-08 — 惡意教材／PDF 指令與 parser DoS

- **前置條件：** Admin upload integration fixture、fake book、受限本機資料夾；PDF 只用安全合成檔。
- **重現：** (1) 上傳合法但含一般自然語言指令的 PDF fixture，走解析與 RAG；(2) 以格式錯誤、超過大小的 synthetic document 驗證拒絕與清理；(3) 不使用爆炸式壓縮、parser exploit 或 production 文件。
- **預期：** 上傳需授權、限制大小與型別；解析錯誤不洩漏 stack/path；內容只作資料，不當作 system instruction；parser CPU/memory 要有明確限制或隔離。
- **main 現況：** MIME/extension/`%PDF-` signature、25 MiB 上限及失敗 cleanup 有 integration tests；PDF 解析器讀取完整檔案至記憶體並呼叫 `pdf-parse`，目前引用程式未顯示獨立 sandbox 或 parser 資源限額。教材 injection 仍是殘餘風險。**PARTIAL / P1**。
- **證據／自動化：** `apps/AI-adm-D1/src/server/app.ts`; `apps/AI-adm-D1/src/server/upload-security.integration.test.ts`; `packages/book-core/src/pdf-parser.ts`; `packages/ai/src/rag/injection-screening.ts`; `packages/ai/src/rag/grounding-validator.ts`。

## AC-09 — QM scope、memory、file、keychain、run trace 洩漏

- **前置條件：** 無；目前 main 沒有 QM adapter／可呼叫的 QM runtime API。
- **重現：** 本票不呼叫部署環境或不存在的 QM endpoint。若未來加入 adapter，在合成 tenant A/B workspace 測 memory、file、keychain、run trace 與 feedback draft 的越權存取。
- **預期：** 現行 main 不應宣稱已有 QM isolation；新 adapter 必須先定義 tenant key、server-side scope、secret broker、retention、audit 與 boundary tests。
- **main 現況：** ownership 文件明確記錄無 standalone QM adapter，並把 `deploy/qm` 列為 deployment-only/future integration boundary；目前 checkout 沒有 `deploy/qm` tree 或 QM runtime adapter。**N/A（架構改道）；不是安全驗收 PASS**。
- **證據／自動化：** `docs/MODULE_OWNERSHIP.md`; `packages/contracts/src/identity.ts`。目前無 QM adapter 測試；新增時 gate 由新 contract/integration tests 建立。

## AC-10 — Secret 出現在 browser bundle、logs、errors、Git 或 artifacts

- **前置條件：** 使用專用合成 secret marker，僅於本機測試 fixture；不使用實際憑證。
- **重現：** build Admin SPA / auth boundary；grep build output 中的 fake server-only marker；讓 provider fake error 包含合成 key；觸發 upload/repository validation errors，檢查 response/log。另檢視 repo/artifact scan 是否有可執行 gate。
- **預期：** browser output、API response、一般 logs 不得出現 secrets、stack、raw provider error 或憑證；所有允許的 diagnostic 欄位明確 allowlist；Git/build artifact 也需自動掃描。
- **main 現況：** Admin bundle test、auth browser-boundary、AI secret redaction、upload safe error 測試存在；`release-gate:student-rag` 會掃描部分 tracked source，`scripts/release-artifacts.mjs` 會掃描它自己產生的診斷 JSON。這不等於 Git history 或所有編譯產物均已掃描。另 Student data-source unavailable 與部分資料讀取 catch 會回傳 `detail`／`String(err)`；引用測試未證明這些錯誤一定不帶路徑或內部訊息。**PARTIAL / P1-P2**。
- **證據／自動化：** `apps/AI-adm-D1/src/security-bundle.test.ts`; `packages/auth/test/browser-boundary.test.ts`; `packages/ai/test/secret-redaction.test.ts`; `packages/ai/src/gateway/secret-redaction.ts`; `packages/ai/src/rag/cerebras.adapter.ts`; `apps/AI-adm-D1/src/server/upload-security.integration.test.ts`; `apps/AI-Stu-R1/server/stu-api.ts`; `scripts/release-gate-student-rag.ts`; `scripts/release-artifacts.mjs`。

## AC-11 — Upload path traversal、MIME spoof、oversize、malformed document

- **前置條件：** Admin upload integration fixture、throwaway upload directory。
- **重現：** (1) multipart 檔名使用 `../`、反斜線與控制字元，但只在 fixture；確認無法離開 upload root；(2) PDF extension/MIME/signature 互相不符；(3) 過大與 malformed multipart/PDF；(4) 模擬 repo insert failure，查暫存檔清理。不要寫入 repo 外任何路徑。
- **預期：** filename 變成安全 basename 並以 exclusive create + random UUID 落盤；不符型別拒絕、oversize 413、malformed 400；失敗檔案清除；raw error/path 不回顯。
- **main 現況：** sanitizer 移除 `/`、`\\` 與控制字元、random UUID/exclusive create；MIME、extension、signature、size、malformed、cleanup 主要情境有測。明確 `../` traversal case 未在 upload test 中找到。**PARTIAL（補明確 traversal fixture）**。
- **證據／自動化：** `apps/AI-adm-D1/src/server/app.ts`; `apps/AI-adm-D1/src/server/books-router.ts`; `apps/AI-adm-D1/src/server/upload-security.integration.test.ts`。

## AC-12 — SSRF / unsafe URL fetch / 內網資源探測

- **前置條件：** fake DNS resolver / fake transport；禁止真實內網連線；以合成 Admin 設定與 credential fixture 檢查 managed provider。
- **重現：** (1) 對 Cerebras base URL validator 傳 localhost、loopback、private/link-local/metadata IP、userinfo、禁用 port；DNS resolver 回 private IP；fake upstream 回跨 origin redirect。(2) 對 Admin managed provider 的 `credentialBaseUrl` / provider `baseUrl` 設 HTTP、loopback、private 或非預期 hostname，觀察 schema 與 provider 呼叫路徑；使用 stub fetch，不發真實連線。
- **預期：** 所有會帶 server credential 的 provider 都應拒絕非 HTTPS、unsafe literal/hostname/address、DNS rebinding 與不安全 redirect，且在連線前拒絕；TLS 仍驗原 hostname；request/response size 與 timeout 有界。不得因 Admin 可設定 URL 就推定目的地可信。
- **main 現況：** Cerebras adapter 每一跳重驗 URL，resolve + validate 後連到同一 pinned IP，跨 origin redirect 拒絕，並有 adversarial URL/DNS/redirect tests。另一方面，Admin managed provider 可從資料庫 credential/config 讀取 base URL；schema 對 `credentialBaseUrl` 僅做 URL 解析，`providerBaseUrl` 的 HTTPS/拒絕清單也不等於全面公網 IP 驗證；OpenAI/Gemini provider 直接使用 fetch 並帶 credential，未共用 Cerebras 的 DNS pinning guard。若具備 Admin 權限或設定/DB 被篡改，這可能形成 SSRF 或憑證外送路徑。**PARTIAL / P1**。
- **證據／自動化：** Cerebras 控制：`packages/ai/src/rag/safe-url.ts`; `packages/ai/src/rag/pinned-fetch.ts`; `packages/ai/src/rag/cerebras.adapter.ts`; `packages/ai/test/rag/safe-url.test.ts`; `packages/ai/test/rag/ssrf-adversarial.test.ts`; `packages/ai/test/rag/cerebras.adapter.test.ts`。通用 provider 路徑：`packages/schema/src/aiGateway.schema.ts`; `apps/AI-adm-D1/src/server/ai/credential-provider.ts`; `packages/ai/src/gateway/providers/openai.provider.ts`; `packages/ai/src/gateway/providers/gemini.provider.ts`。目前找不到覆蓋這些通用 provider URL 的等價 SSRF regression tests。

## AC-13 — Audit 缺漏、竄改或過度記錄

- **前置條件：** throwaway DB；合成 actor/query；audit repository test fixture。
- **重現：** 走 login success/failure/logout 和 admin mutation；提交含合成密碼/API key marker 的 request body；查看 audit row 及 AI request log 的 allowlisted fields；檢查 log store 是否有 append-only / external retention。
- **預期：** 關鍵認證與 mutation 有事件；audit metadata 不存 body/cookie/password/key；AI prompt/answer redacted、bounded；log 遺失/竄改需能偵測或明確承認無此保證。
- **main 現況：** Admin auth/mutation audit 與 allowlist 有 integration coverage；DB logger 對問題/答案做 pattern redaction、限長，diagnostics 使用 allowlist。Audit 位於一般 DB repository，未見不可變/異地保存或完整性校驗；`question`/`answer` 仍屬使用者內容，redaction 不是 PII 去識別。**PARTIAL / P2**。
- **證據／自動化：** `apps/AI-adm-D1/src/server/admin-route-boundary.ts`; `apps/AI-adm-D1/src/server/admin-api.integration.test.ts`; `packages/db/src/repositories/aiProvider.repo.ts`; `apps/AI-adm-D1/src/server/ai/db-prompt-logger.ts`; `packages/ai/test/secret-redaction.test.ts`。

## AC-14 — Dependency、script、CI/release supply chain

- **前置條件：** isolated checkout、lockfile-only diff、無 production credential。
- **重現：** 對 lockfile PR 檢查直接依賴差異、registry URL/integrity、`hasInstallScript`；執行 frozen install；在隔離 build 輸出掃描 secret/map；執行 package boundary 與 release gate。不得執行 `audit fix` 或外部部署作為本案例測試。
- **預期：** lockfile 可重現且來源可審；未核准依賴/script 變動阻擋；CI 對 audit、boundary、secret/artifact scan 設定明確 gate；release 不讀取未核准 secret 或執行 migration/deploy。
- **main 現況：** pnpm/npm lockfiles、boundary/release scripts 與 CODEOWNERS 有可審證據；未找到 `.github/workflows/*` 自動化 audit/secret scan 定義，需避免把手動命令描述為持續 gate。**PARTIAL / P2**。
- **證據／自動化：** `pnpm-lock.yaml`; `package-lock.json`; `site/package-lock.json`; `scripts/boundary-check.sh`; `scripts/release-gate-student-rag.ts`; `scripts/release-artifacts.mjs`; `.github/CODEOWNERS`。
