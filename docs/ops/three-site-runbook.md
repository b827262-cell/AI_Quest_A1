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

缺漏與錯誤時的行為（一律 fail closed）：

- 上述變數皆未設定：站點為 `standalone`，沿用舊的本地行為，不代理任何請求。
- 角色與站名不成對，或值不被認得：站點為 `misconfigured`。除 `/api/health` 外，所有 `/api/*` 回 503 `site_misconfigured`。
- 次站缺少 `PRIMARY_ORIGIN`，或其值不是 https origin：其自身 API 前綴回 503 `backend_disabled`，且不對外呼叫。

Worker 會在每個請求開始時，把這些變數從 `env` 複製到 `globalThis`，與 D1、R2 綁定的做法相同。

## 3. 路由規則

| 請求 | 主站 | 次站（student 或 admin） |
| --- | --- | --- |
| 頁面與靜態資源 | 本地回應 | 本地回應 |
| `/api/health` | 本地回應 | 本地回應 |
| `/api/<自己的站名>/*`（student 為 `/api/student/*`，admin 為 `/api/admin/*`） | 本地回應 | 代理到主站同一路徑，回應帶 `x-data-plane: primary` |
| `/api/internal/sync/*` | 本地回應 | 404 `not_found`，不對外呼叫 |
| 其他站的前綴（例如 student 收到 `/api/admin/*`） | 本地回應 | 404 `not_found`，不對外呼叫 |

代理行為：

- 保留 `x-forwarded-for`。會略過 `host`、`content-length`、`cf-connecting-ip`、`cf-ray`，並加上 `x-forwarded-host` 與 `x-forwarded-proto`。
- 代理只在 production 執行，與既有行為相同。非 production 的次站會在本地處理請求。
- 代理的目標路徑會再次檢查是否屬於本站前綴，作為第二道防線。

## 4. health 契約

`GET /api/health` 的契約欄位為 `status`、`role`、`site`、`primaryOrigin`、`gitSha`、`d1`、`r2`。
為相容既有使用者，仍保留 `edge`、`phase`、`storage`、`backendTarget`、`version`、`buildId`、`identitySource`、`time`。

| 站點 | role | site | primaryOrigin | d1 | r2 |
| --- | --- | --- | --- | --- | --- |
| 主站 | `primary` | `backend` | `null` | `bound` | `bound` |
| 學生次站 | `secondary` | `student` | 主站 origin | `unbound` | `unbound` |
| 管理次站 | `secondary` | `admin` | 主站 origin | `unbound` | `unbound` |

三站的 `gitSha` 必須是同一個有效 SHA。capture 腳本會檢查這一點。

## 5. 部署順序

1. 在本地確認目標 commit 通過 `cd site && npm ci && npm run typecheck && npm test`，以及 `npm run environment:align:production`。
2. 先設定三站的執行期變數，再部署程式碼。三站的 `GIT_SHA` 都填同一個 commit。
3. 先部署主站，並完成第 6 節的驗證。主站的 API 行為對既有次站相容，因此可以先上線。
4. 依序部署學生次站與管理次站，每站部署後各自驗證。
5. 三站上線後，capture 才會與新契約一致。是否寫回 production manifest 須由 Owner 指示；本手冊不要求執行。

注意：次站若只部署程式碼、未設定 `SITE_ROLE` 與 `PRIMARY_ORIGIN`，會退回本地 standalone 行為，且沒有 D1，使頁面 API 出錯。部署前必須先設定變數。

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

- **O-1 身分轉送尚未簽章。** `x-a01-relay` 簽章屬於本版的擴充點，尚未實作。目前主站信任 `oai-authenticated-user-*` 與 `x-admin-key` 標頭，次站會原樣轉送。上線前須先確認 Sites 會在主站入口清除外來的 `oai-*` 標頭。這是設計文件標示的最大風險，目前仍待驗證。
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
