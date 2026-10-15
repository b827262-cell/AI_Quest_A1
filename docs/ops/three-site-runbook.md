# A-01 三站運行手冊（主站－次站）

本手冊說明三個 Sites 專案如何由同一個 commit 部署為一個主站與兩個次站，以及部署、驗證、回滾與尚未完成的開放問題。
設計依據為 A-01 三站整合設計文件第 3 至第 5 節。程式碼位置：`site/app/api/backend-client.ts`、`site/app/api/health/route.ts`、`site/worker/index.ts`、`site/scripts/capture-environment-source-of-truth.mjs`。

## 1. 拓撲與宣告

| 站點 | site | role | Sites project_id | primary_origin | D1 / R2 |
| --- | --- | --- | --- | --- | --- |
| 主站 | `backend` | `primary` | `appgprj_6aa80235182c8191a876361138ecbc36` | 無 | `DB` / `BOOKS_BUCKET` |
| 學生次站 | `student` | `secondary` | `appgprj_6a843b2ece70819191132bd6e99df7a1` | `https://ai-quest-a1-backend.b827262.chatgpt.site` | 不綁定（`unbound`） |
| 管理次站 | `admin` | `secondary` | `appgprj_6a843b6432f88191aa4cc090c236f3d3` | `https://ai-quest-a1-backend.b827262.chatgpt.site` | 不綁定（`unbound`） |

- 宣告來源為 `site/deploy/targets.json`。`site/tests/three-site-topology.test.mjs` 會檢查它與 `docs/phase4a/environment-source-of-truth.json`、`site/.openai/hosting.json` 一致。
- 只有主站綁定 D1 與 R2。次站若回報 D1 或 R2 已綁定，即視為設定錯誤。
- 瀏覽器只與自己所屬的次站通訊。資料只存在主站的 D1 與 R2 中。

## 2. 執行期變數（每站必填）

| 變數 | 值 | 說明 |
| --- | --- | --- |
| `SITE_ROLE` | `primary` 或 `secondary` | 宣告角色。Worker 不會從主機名稱推斷角色。 |
| `SITE_NAME` | `backend`、`student` 或 `admin` | 必須與角色成對：`primary` 對 `backend`，`secondary` 對 `student` 或 `admin`。 |
| `PRIMARY_ORIGIN` | `https://...`（次站必填） | 只能是純 https origin：不得含路徑、帳號密碼，可帶單一結尾 `/`。主站忽略此值。 |
| `GIT_SHA` | 同一個完整 commit SHA | 健康檢查的 `gitSha` 來源。三站必須相同，且不得為 `unknown`。 |
| `ADMIN_EMAILS` | 逗號分隔的位址清單（主站必填） | 管理員 allowlist。格式為 `位址1,位址2`；每項會去除前後空白、不分大小寫、以完全相等比對。未設定或為空時，沒有任何人會是管理員（fail-closed）。次站不需要此變數。 |

缺漏與錯誤時的行為（一律 fail closed）：

- 上述變數皆未設定：站點為 `standalone`，沿用舊的本地行為，不代理任何請求。
- 角色與站名不成對，或值不被認得：站點為 `misconfigured`。除 `/api/health` 外，所有 `/api/*` 回 503 `site_misconfigured`。
- 次站缺少 `PRIMARY_ORIGIN`，或其值不是 https origin：其自身 API 前綴回 503 `backend_disabled`，且不對外呼叫。
- 主站未設定 `ADMIN_EMAILS`：沒有任何帳號會被視為管理員（fail-closed），`/api/health` 的 `adminAllowlist` 回 `unset`。管理員身分只來自這份 allowlist；`oai-authenticated-user-role` 標頭不再授予管理員。

Worker 會在每個請求開始時，把這些變數從 `env` 複製到 `globalThis`，與 D1、R2 綁定的做法相同。

## 3. 路由規則

| 請求 | 主站 | 次站（student 或 admin） |
| --- | --- | --- |
| 頁面與靜態資源 | 本地回應 | 本地回應 |
| `/api/health` | 本地回應 | 本地回應 |
| `/api/<自己的站名>/*`（student 為 `/api/student/*`，admin 為 `/api/admin/*`） | 本地回應 | 代理到主站同一路徑，回應帶 `x-data-plane: primary` |
| `/api/internal/sync/*` | 本地回應 | 404 `not_found`，不對外呼叫 |
| 其他站的前綴（例如 student 收到 `/api/admin/*`） | 本地回應 | 404 `not_found`，不對外呼叫 |
| 必須解碼才能判定的 `/api` 路徑（`%2f`、`%2e`、`%25`、控制字元，或殘留 `.`／`..` 段） | 400 `ambiguous_path` | 400 `ambiguous_path`，不對外呼叫 |

路徑判定只有一套：Worker 不再自己比對 `/api/` 字串，而是把請求原樣交給 `gateApiRequest`，由它正規化後決定。正規化會折疊重複斜線、不分大小寫、忽略尾斜線，因此 `/API/admin/...`、`//api//admin//...`、`/api/admin/me/` 與直接寫法得到同一個結論。位元組需要解碼才看得出是不是分隔符或點（`%2f`、`%5c`、`%2e`）、屬於雙重編碼（`%25`），或解碼後仍留有 `.`／`..` 段時，一律拒絕而不挑一個解釋；只帶資料的編碼（例如 `%20`）不受影響。平台在請求抵達 Worker 前就已解析普通的 `.`／`..` 段，因此這類 traversal 會落到頁面路由，永遠不會變成對外代理呼叫。`/api/health/` 與 `/api/health` 同為可觀察路徑。

代理行為：

- 保留 `x-forwarded-for`。會略過 `host`、`content-length`、`cf-connecting-ip`、`cf-ray`，並加上 `x-forwarded-host` 與 `x-forwarded-proto`。
- 代理只在 production 執行，與既有行為相同。非 production 的次站會在本地處理請求。
- 代理的目標路徑會再次檢查是否屬於本站前綴，作為第二道防線。

## 4. health 契約

`GET /api/health` 的契約欄位為 `status`、`role`、`site`、`primaryOrigin`、`gitSha`、`d1`、`r2`、`adminAllowlist`、`relayMode`、`relayKeys`、`relaySeen`。
為相容既有使用者，仍保留 `edge`、`phase`、`storage`、`backendTarget`、`version`、`buildId`、`identitySource`、`time`。
`relayMode`／`relayKeys`／`relaySeen` 是身分轉送簽章的觀測欄位，永不輸出金鑰；各值意義與上線步驟見 [`relay-rollout.md`](./relay-rollout.md)。

`adminAllowlist` 只回報 `configured` 或 `unset`，永遠不含任何位址。當它為 `unset` 時，沒有任何帳號會是管理員。

| 站點 | role | site | primaryOrigin | d1 | r2 |
| --- | --- | --- | --- | --- | --- |
| 主站 | `primary` | `backend` | `null` | `bound` | `bound` |
| 學生次站 | `secondary` | `student` | 主站 origin | `unbound` | `unbound` |
| 管理次站 | `secondary` | `admin` | 主站 origin | `unbound` | `unbound` |

三站的 `gitSha` 必須是同一個有效 SHA。capture 腳本會檢查這一點：一致時把 `worker.deployed_git_sha` 重新認證為該 commit；不一致時不改寫該欄位，並在 `capture_evidence.git_sha` 標示為沿用前次 capture。`worker.version` 仍無法經 HTTP 觀察，一律沿用前次。

## 5. 部署順序

1. 在本地確認目標 commit 通過 `cd site && npm ci && npm run typecheck && npm test`，以及 `npm run environment:align:production`。
2. 先設定三站的執行期變數，再部署程式碼。三站的 `GIT_SHA` 都填同一個 commit。**主站部署前必須先設定 `ADMIN_EMAILS`**，否則上線後沒有任何人能登入管理端（fail-closed）。
3. 先部署主站，並完成第 6 節的驗證。主站的 API 行為對既有次站相容，因此可以先上線。
4. 依序部署學生次站與管理次站，每站部署後各自驗證。
5. 三站上線後，capture 才會與新契約一致。是否寫回 production manifest 須由 Owner 指示；本手冊不要求執行。

注意：次站若只部署程式碼、未設定 `SITE_ROLE` 與 `PRIMARY_ORIGIN`，會退回本地 standalone 行為，且沒有 D1，使頁面 API 出錯。部署前必須先設定變數。主站若未設定 `ADMIN_EMAILS`，管理端會 fail-closed 而無人可登入；`/api/health` 的 `adminAllowlist` 為 `unset` 即為此徵兆。

## 6. 部署後驗證（只使用 GET）

```bash
curl -sS https://ai-quest-a1-backend.b827262.chatgpt.site/api/health
curl -sS https://ai-quest-a1-student.b827262.chatgpt.site/api/health
curl -sS https://ai-quest-a1-admin.b827262.chatgpt.site/api/health
curl -sSi https://ai-quest-a1-student.b827262.chatgpt.site/api/student/me | grep -i '^x-data-plane'
curl -sS -o /dev/null -w '%{http_code}\n' https://ai-quest-a1-student.b827262.chatgpt.site/api/internal/sync/runs
curl -sS -o /dev/null -w '%{http_code}\n' https://ai-quest-a1-student.b827262.chatgpt.site/api/admin/overview
```

預期結果：

- 三個 health 回應符合第 4 節的表格，且 `gitSha` 完全相同。
- 學生次站的 `/api/student/me` 回應帶 `x-data-plane: primary`。
- 次站的 `/api/internal/sync/runs` 與 `/api/admin/overview` 回 `404`。

## 7. 回滾

- 三站回到上一個已驗證的 commit。production manifest 目前記錄的 deployed commit 為 `f0085202150c67760040644f1db3d6c479dc2074`，實際回滾目標以 Owner 指定為準。
- 不建議只移除次站的 `SITE_ROLE` 作為回滾。這會讓次站退回沒有 D1 的本地 standalone 行為。較安全的做法是回滾次站的 commit。
- 若要暫時停止次站代理，可移除 `PRIMARY_ORIGIN`。次站的 API 會回 503 `backend_disabled`，不會對外呼叫。

## 8. 開放問題與已知限制

- **O-1 身分轉送已改為簽章（PR #57／#58）。** 次站以每站金鑰對入站的 `oai-*` 做 HMAC-SHA256 簽章，刪除入站 `oai-*`／`x-a01-relay-*` 後帶 `x-a01-relay-*` 轉送；主站驗章通過才採用作身分。上線、驗證、回滾與金鑰輪替見 [`relay-rollout.md`](./relay-rollout.md)。管理員權限仍只由伺服器端 `ADMIN_EMAILS` allowlist 決定：`oai-authenticated-user-role` 與 email 子字串都不授予管理員（issue #47）；`x-admin-key` 僅在非 production 的合成測試有效。**O-1a 仍是上線前閘門**：次站會替入站 `oai-*` 簽章，上線前須先確認 Sites 會在請求抵達 Worker 前清除外來的 `oai-*`，否則直打次站即可偽造身分；未通過前不得進入 `transitional`／`strict`。
- **O-2 平台注入方式待確認。** 需確認 Sites 是否支援每個專案注入自己的執行期變數與 secret。若只能於建置時寫入，則必須逐站建置，並寫入 `SITE_ROLE`、`SITE_NAME`、`PRIMARY_ORIGIN`、`GIT_SHA`（不含 secret）。
- **O-3 逐站部署工具未納入本版。** 設計文件第 5 節提到的 `deploy-target.mjs` 與 `npm run deploy:target` 未納入本版。在工具完成前，請依第 5 節手動部署。
- **O-4 主站直接回應的標籤仍為舊值。** 主站本地路由仍標示 `x-data-plane: shared-backend`，本版未改動各路由。只有次站的代理回應標示 `primary`。
- **O-5 `x-served-by` 未實作。** 設計文件提到的 `x-served-by` 標頭本版未加入。
- **O-6 production manifest 仍為舊的 legacy 證據。** `docs/phase4a/environment-source-of-truth.json` 尚未依新契約重新擷取。擷取只能在三站上線後進行，且寫回須經 Owner 指示。
- **O-7 `site/.openai/hosting.json` 保留。** 它是主站的宣告（project `appgprj_6aa8…`），也是 alignment 門禁讀取的來源，不可刪除。repo 根目錄的舊 `.openai/hosting.json` 已於先前移除，本版測試會確認它不存在。

## 9. 本地驗證

- `cd site && npm ci && npm run typecheck && npm test`。`tests/three-site-topology.test.mjs` 會在同一程序內模擬三站，不需要網路。
- `npm run environment:align:production`，在 `site/` 目錄執行。
- 本手冊的步驟不包含對 production 的寫入。所有 production 驗證僅使用 GET。

## 10. 身分轉送簽章上線

次站簽章（PR #57）與主站驗章（PR #58）的上線另見 [`relay-rollout.md`](./relay-rollout.md)：概念與三模式行為表、執行期變數清單、上線前閘門（含 O-1a）、部署順序與 `/api/health` 驗證、回滾、金鑰輪替與疑難排解。上線順序為主站 `transitional` → 次站 → 觀察 → 主站 `strict`；每站部署都需 Owner 逐站授權。
