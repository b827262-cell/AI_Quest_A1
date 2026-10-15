# A-01 身分轉送簽章上線手冊（Relay Rollout Runbook）

本手冊是三站運行手冊（`docs/ops/three-site-runbook.md`）的補充，說明次站簽章（PR #57）與主站驗章（PR #58）的上線、驗證、回滾、金鑰輪替與疑難排解。
設計依據為 A-01 三站整合設計文件（該文件在 Project，不在本 repo）；本手冊所有數值一律以程式碼為準，逐項對應見第 9 節。程式碼位置：`site/lib/relay-signature.ts`、`site/lib/relay-verification.ts`、`site/app/api/backend-client.ts`、`site/app/api/auth-helper.ts`、`site/app/api/health/route.ts`、`site/worker/index.ts`、`site/drizzle/0003_superb_purifiers.sql`。

本手冊不提供可直接複製執行的 production 寫入指令；任何對 production 的寫入（部署、migration、變數變更）都必須先取得 Owner 授權。

## 1. 概念與資料流

次站在 production 代理自己的 `/api/<site>/*` 時：

1. 讀入站的 `oai-authenticated-user-id` 與 `oai-authenticated-user-email`（平台在次站入口注入的身分）。
2. 以本站的 `A01_RELAY_SIGNING_KEY` 對 canonical 字串做 HMAC-SHA256，產生 `x-a01-relay-*` 七個標頭：`site`、`ts`、`nonce`、`user-id`、`user-email`、`user-role`、`sig`。
3. 刪除入站所有 `oai-*` 與 `x-a01-relay-*` 標頭，不原樣轉送。
4. 帶上簽章後的 `x-a01-relay-*` 轉送主站同一路徑。

主站收到後：

5. `verifyIncomingRelay` 驗章：站別金鑰（student／admin 各自一組）、時戳在 ±300s 內、canonical 字串（method／path／query digest／body digest／site／user-id／email／role／ts／nonce）與簽章相符；非 GET／HEAD 另以 D1 `relay_nonces` 做重放防護。
6. 只有驗章通過才採用簽章中的 userId／email 為身分。
7. 管理員權限仍只由主站的 `ADMIN_EMAILS` allowlist 決定。簽章中的 role 不授權：次站一律送 `-`，主站也不讀 signed role。

canonical 規則（`site/lib/relay-signature.ts`）：

- canonical path 保留大小寫，只折疊重複斜線並去除單一結尾斜線；因此同一路徑的大小寫不同會被視為不同簽章。
- query 與非 GET／HEAD 的 body 以 SHA-256 digest 進 canonical；GET／HEAD 的 body digest 固定為 `-`。
- nonce 格式為 `[A-Za-z0-9_-]{16,128}`；GET／HEAD 不寫入 nonce 表。
- 缺少的值以 `-` 為 sentinel；合法的 userId／email／role 不得等於 `-`。

### 1.1 三種模式的行為

`A01_RELAY_MODE` 只在主站判讀。解析規則：未設定、空字串或 `off` → `off`；`transitional` → `transitional`；其他任何值（包含拼錯）→ `strict`（fail closed）。

| 情境 | `off`（含未設定／空字串） | `transitional` | `strict`（含任何未識別值） |
| --- | --- | --- | --- |
| 請求沒有任何 `x-a01-relay-*` | 讀未簽章的 `oai-*`（legacy 行為） | 讀未簽章的 `oai-*`（legacy 行為） | guest；完全不讀 `oai-*` |
| 有 `x-a01-relay-*` 且驗章通過 | 不驗章、忽略 relay 標頭；由於次站已刪除 `oai-*`，通常變成 guest | 採用簽章 userId／email 為身分 | 同 `transitional` |
| 有 `x-a01-relay-*` 但驗章失敗 | 不驗章、忽略 relay 標頭，改依 legacy `oai-*` 判斷（沒有則 guest） | 回 `relayRejected` → `401 {"error":"unauthorized"}`，**不回退** `oai-*` | 同 `transitional` |
| 簽章 role 是否授權 | 不適用 | 否 | 否 |

重點：

- **未識別值一律 `strict`**，不會靜默退回 `off` 或 `transitional`。
- **relay 標頭驗章失敗不得回退到 `oai-*`**：只要請求帶了 `x-a01-relay-*` 且驗章失敗，`transitional`／`strict` 都直接回 401，不會改讀未簽章的 `oai-*`。
- `off` 是舊行為：它不驗章，也不認識 relay 標頭。次站一旦開始簽章（步驟 3 會刪除 `oai-*`），主站若仍在 `off`，身分會掉成 guest。因此上線順序必須先讓主站進入 `transitional`，再部署次站。

## 2. 執行期變數（只列名稱）

| 站別 | 變數名稱 | 必要性 | 說明 |
| --- | --- | --- | --- |
| 次站 | `A01_RELAY_SIGNING_KEY` | 要簽章就必填 | 本站簽章金鑰。長度必須 ≥ 32 才被接受，否則等同未設定、沒有簽章能力。 |
| 次站 | `A01_RELAY_SITE` | 要簽章就必填 | 必須等於本站的 `SITE_NAME`（`student` 或 `admin`）；不符時視為沒有簽章能力。 |
| 主站 | `A01_RELAY_KEY_STUDENT` | 必填 | 學生次站的現行驗章金鑰（≥ 32）。 |
| 主站 | `A01_RELAY_KEY_STUDENT_PREV` | 輪替時使用 | 學生次站的舊驗章金鑰；輪替重疊期與現行金鑰並存，兩把都接受。 |
| 主站 | `A01_RELAY_KEY_ADMIN` | 必填 | 管理次站的現行驗章金鑰（≥ 32）。 |
| 主站 | `A01_RELAY_KEY_ADMIN_PREV` | 輪替時使用 | 管理次站的舊驗章金鑰；輪替重疊期與現行金鑰並存，兩把都接受。 |
| 主站 | `A01_RELAY_MODE` | 必填（上線時） | `off`／`transitional`／`strict`。未設定＝`off`，未識別值＝`strict`。 |
| 主站 | `ADMIN_EMAILS` | 必填 | 管理員 allowlist，與簽章無關；簽章只決定身分，不決定管理員。 |

規則：

- **兩站金鑰不得相同。** 若 student 與 admin 的任何一把金鑰相等，兩個站的金鑰清單都會被視為空，所有 relay 驗章一律失敗（`relayKeys` 為 0）。
- 金鑰只在長度 ≥ 32 時計入；`_PREV` 與現行金鑰同時存在時，兩把都會被嘗試。
- 本手冊只寫變數名稱，不寫任何值；變數的注入方式見三站運行手冊第 2 節。

## 3. 上線前閘門

以下四項全部通過才可上線；缺一項即暫停。

### (a) staging 實測 O-1a：production 是否剝除外部帶入的 `oai-*`

次站會替「入站的 `oai-*`」簽章。如果外部請求可以直接帶 `oai-*` 打到次站，就等於可以讓次站代簽任何身分；只要該 email 在主站 `ADMIN_EMAILS` 內，就能取得管理員。這是整套機制的安全前提。

- 驗證方式（只在 staging，不碰 production）：對 staging 站送出帶有 `oai-authenticated-user-id`／`oai-authenticated-user-email` 的請求，觀察 Worker 是否把該值當成身分（例如 staging 的 `/api/student/me` 是否回傳這個偽造 id／email）。
- 判定：若 Worker 把外部帶入的 `oai-*` 當成身分，代表平台未在抵達 Worker 前剝除，**O-1a 不通過**；此時不得進入 `transitional` 或 `strict`。若已被剝除（Worker 看不到該標頭），才可繼續。
- 這項未確認前，`transitional` 同樣有風險，因為 `transitional` 只要驗章通過就會採用身分。

### (b) `ADMIN_EMAILS` 已設定

主站部署前必須先設定 `ADMIN_EMAILS`，否則上線後沒有任何帳號是管理員（fail-closed）。以主站 `/api/health` 的 `adminAllowlist` 是否為 `configured` 確認。

### (c) 三站變數先設好再部署

先設定執行期變數，再部署程式碼：

- 主站：`A01_RELAY_KEY_STUDENT`、`A01_RELAY_KEY_ADMIN`（輪替時另有 `_PREV`）、`A01_RELAY_MODE=transitional`、`ADMIN_EMAILS`。
- 次站：各自的 `A01_RELAY_SIGNING_KEY`、`A01_RELAY_SITE`。
- 兩站金鑰不得相同。

### (d) 主站 D1 migration `0003`（`relay_nonces`）先套用

`site/drizzle/0003_superb_purifiers.sql` 建立 `relay_nonces(nonce text PRIMARY KEY NOT NULL, expires_at integer NOT NULL)`；`site/db/schema.ts` 有對應宣告。非 GET／HEAD 的簽章請求需要這張表做重放防護；未套用時 D1 寫入失敗，該類請求一律 401。

如何在不打 production 的前提下檢查：

- 靜態核對 repo：確認 `site/drizzle/0003_superb_purifiers.sql` 的內容，以及 `site/db/schema.ts` 的 `relayNonces` 宣告一致。
- 本地測試：`cd site && npm test`（或單跑 `tests/relay-verify.test.mjs`）會在記憶體 SQLite 依序套用 `drizzle/*.sql`，驗證 `relay_nonces` 的表、主鍵與過期清理行為。這是不接觸 production 就能驗證 migration 正確性的方式。
- 檢查 production 是否已套用：由 Owner 在 Sites／Cloudflare 的 D1 主控台以唯讀查詢確認 `sqlite_master` 是否含 `relay_nonces`。本手冊刻意不提供可直接複製執行的 production 指令。
- 不可用 `/api/health` 的 `d1: bound` 推斷 migration 已套用；那只代表 binding 存在，不代表資料表存在。

需 Owner 授權的步驟：套用 0003 是對 production D1 的寫入。必須先取得 Owner 逐項授權，由 Owner／平台維運以正式的 D1 migration 流程執行。時機必須在次站開始簽章之前（也就是主站切到 `transitional`、次站部署之前）。

## 4. 部署順序與驗證

每一步都需要 Owner 逐站授權。順序固定為：主站（`transitional`）→ 次站 → 觀察 → 主站 `strict`。

1. **主站前置**：完成第 3 節閘門；套用 migration 0003；設定主站變數（模式先為 `transitional`）。
2. **部署主站**（含 #58 驗章程式碼）。部署後驗證主站 health。
3. **部署次站**：設定該站 `A01_RELAY_SIGNING_KEY`／`A01_RELAY_SITE` 後部署（含 #57 簽章程式碼）。學生與管理次站逐站部署、逐站驗證；每站都要 Owner 授權。
4. **觀察期**：觀察 401 比例與身分是否正常；建議至少涵蓋一個時鐘 skew 窗（±300s）加一個部署週期。
5. **主站切 `strict`**：確認已無未簽章請求後，把 `A01_RELAY_MODE` 改為 `strict`（只改變數，不改程式）。

`GET /api/health` 的欄位意義（永遠不輸出金鑰）：

| 欄位 | 意義 |
| --- | --- |
| `relayMode` | 該站目前判讀到的模式：`off`／`transitional`／`strict`。次站通常未設定，回報 `off`。 |
| `relayKeys` | 主站可用的驗章金鑰總數（student＋admin 的現行與 `_PREV`，去重衝突後）。`0` 代表沒有任何可用金鑰：未設定、長度 < 32，或兩站共用金鑰。永不輸出金鑰本身。 |
| `relaySeen` | 對「本次 health 請求」的 relay 驗章結果：`none`（沒有 relay 標頭）／`valid`（驗章通過）／`invalid`（有 relay 標頭但驗章失敗）。 |

驗證注意：

- 主站直打 `/api/health` 通常只會看到 `relaySeen: none`，因為 health 由各站本地回應、不經次站簽章代理。要觀察 `valid` 需在 staging／合成環境送出帶簽章的請求（`tests/relay-verify.test.mjs` 已涵蓋）。
- `relayKeys` 的預期值：主站 student＋admin 兩把現行金鑰時為 2；輪替重疊期為 3 或 4；若兩站共用金鑰會是 0（視為設定錯誤）。
- health 是 GET，不寫 nonce；非 GET 的 D1 nonce 路徑請在 staging／測試驗證，不對 production 做寫入。

## 5. 回滾

- **首選（不改程式）**：把主站 `A01_RELAY_MODE` 改回 `transitional`。這是恢復相容最快的方式，不需重新部署。
- **切勿在主站 `strict` 下單獨回退次站。** `strict` 會忽略未簽章身分；若次站被單獨回退成舊版（原樣轉送 `oai-*`），這些請求會變成 guest／401，等於次站使用者全數掉線。
- **回退順序為主站 → 次站。** 若必須回退 commit：先把主站模式降到 `transitional`，再依序回退次站 commit，最後才在必要時回退主站 commit。
- 回退到 `off` 的警告：`off` 會忽略 relay 標頭；若次站仍是簽章版（已刪除 `oai-*`），身分會掉成 guest。`off` 只適用於同時把次站回退到未簽章版本。
- 版本號：三站運行手冊第 7 節目前記錄的 production deployed commit 為 `f0085202150c67760040644f1db3d6c479dc2074`；實際回退目標以 Owner 指定為準，本手冊不另行編造版本號。

## 6. 金鑰輪替 SOP（雙鑰重疊）

以「舊鑰 → 新鑰」為例，student 與 admin 分開處理：

1. **主站接受新舊兩把**：把 `_PREV` 設為舊金鑰，同時把現行金鑰換成新金鑰。此時 `_PREV`（舊）與現行（新）都被接受。
2. **次站換新鑰**：把該站 `A01_RELAY_SIGNING_KEY` 換成新金鑰並部署。
3. **觀察**：涵蓋一個 skew 窗（±300s，建議至少數分鐘）加一個部署週期，確認沒有 `invalid` 上升。
4. **移除 `_PREV`**：確認次站已全面使用新金鑰後，移除主站的 `_PREV`。

注意：

- 順序不可顛倒。若先換次站金鑰、主站尚未接受新金鑰，簽章會驗不過而出現 401。
- 輪替期間 `relayKeys` 會暫時增加（現行＋`_PREV`）。
- 兩站金鑰不得相同；一次只輪替一個站。

## 7. 疑難排解

對外一律只回單一 `401 {"error":"unauthorized"}`，不洩漏失敗原因；診斷請看主站 health 的 `relaySeen` 與次站設定。

| 症狀 | 可能原因 | 檢查與處置 |
| --- | --- | --- |
| 401 `{"error":"unauthorized"}`（單一對外錯誤） | relay 驗章失敗：簽章不符、站別不符、時戳超出 ±300s、nonce 重放、path／query／body 被改、金鑰未設或 < 32、兩站共用金鑰、D1 不可用 | 看主站 `relaySeen`；確認次站 `A01_RELAY_SIGNING_KEY`／`A01_RELAY_SITE` 與主站對應金鑰。relay 失敗絕不回退 `oai-*`。 |
| 次站回 `503 {"error":"relay_signing_unavailable"}` | 次站缺簽章能力，而請求帶有 `oai-*` 身分：`A01_RELAY_SIGNING_KEY` 未設／< 32，或 `A01_RELAY_SITE` 與 `SITE_NAME` 不符 | 補齊次站變數後重新部署；未帶身分的匿名請求不會因此失敗。 |
| 身分間歇性失效 | 兩站時鐘偏差超過 ±300s | 校正次站與主站（平台）時鐘；確認時間同步。 |
| 非 GET／HEAD 一律 401、GET 正常 | 非 GET 依賴 D1 `relay_nonces`：migration 0003 未套用、D1 binding 缺失或查詢失敗 | 套用 migration 0003（Owner 授權）；確認主站 D1 binding。D1 不可用時一律 401。 |
| 大 body 回 401 而非 413 | 有 relay 標頭時，超過 body 上限（一般 8 MiB／upload 21 MiB）在簽章驗證階段就判 `invalid` | 這是預期行為；請在上游縮小 payload。無 relay 標頭時不走此檢查，平台層可能另有更早的限制。 |
| admin 路由回 403 | `ADMIN_EMAILS` 未設或該 email 不在 allowlist：已驗章身分只會是 `student` | 設定主站 `ADMIN_EMAILS`；以 health `adminAllowlist=configured` 確認。完全無身分時 admin 路由回 401。 |

## 8. 已知限制與後續

- **`site/app/chatgpt-auth.ts` 仍讀未簽章標頭。** 它直接讀 `oai-authenticated-user-id`／`-email`／`-full-name`，只用於顯示（`getChatGPTUser`）；不得用於授權。授權一律走 `getNormalizedAuth` 與 `ADMIN_EMAILS`。
- **CORS allow-headers 殘留宣告待清理（PR-E）。** `site/app/api/backend-client.ts` 的 `handleCors` 仍在 `Access-Control-Allow-Headers` 宣告 `oai-authenticated-user-*` 系列；這些是瀏覽器端的舊宣告，待 PR-E 清理。
- **主站直打 health 的 `relaySeen` 多為 `none`。** 要觀察 `valid` 需在 staging／合成環境送出帶簽章請求。
- **設計文件不在 repo。** A-01 三站整合設計文件在 Project；本手冊以程式碼為準。
- **O-1a 未通過前不得上線。** 見第 3(a) 節。

## 9. 程式碼交叉核對

| 項目 | 值 | 程式碼位置 |
| --- | --- | --- |
| 次站簽章金鑰長度門檻 | ≥ 32 | `site/app/api/backend-client.ts`（`signingKey.length >= 32`） |
| 次站站別必須相符 | `A01_RELAY_SITE === SITE_NAME` | `site/app/api/backend-client.ts` |
| 次站刪除 `oai-*`／`x-a01-relay-*` | 全部刪除 | `site/app/api/backend-client.ts`（轉送標頭迴圈） |
| 次站 signed role 一律 `-` | `-` | `site/app/api/backend-client.ts` |
| 模式解析 | 未設／空／`off`→`off`；`transitional`→`transitional`；其他→`strict` | `site/lib/relay-verification.ts`（`readRelayMode`） |
| 時鐘偏差 | ±300s | `site/lib/relay-verification.ts`（`MAX_CLOCK_SKEW_SECONDS`） |
| 一般 body 上限 | 8 MiB | `site/lib/relay-verification.ts`（`MAX_SIGNED_BODY_BYTES`） |
| upload body 上限 | 21 MiB | `site/lib/relay-verification.ts`（`MAX_SIGNED_UPLOAD_BYTES`） |
| nonce 表 | `relay_nonces(nonce PK, expires_at)` | `site/drizzle/0003_superb_purifiers.sql`、`site/db/schema.ts` |
| nonce 僅非 GET／HEAD 使用 | GET／HEAD 不寫表 | `site/lib/relay-verification.ts` |
| 驗章失敗不回退 `oai-*` | `relayRejected` → 401 | `site/app/api/auth-helper.ts`、各 `app/api/**/route.ts` |
| 管理員只由 allowlist 決定 | `ADMIN_EMAILS` | `site/app/api/auth-helper.ts`（`isAllowedAdminEmail`） |
| health 欄位 | `relayMode`／`relayKeys`／`relaySeen` | `site/app/api/health/route.ts` |
| 兩站金鑰不得相同 | 共用即兩站皆空 | `site/lib/relay-verification.ts`（`siteKeys`） |
| 未簽章標頭僅供顯示 | `chatgpt-auth.ts` | `site/app/chatgpt-auth.ts` |

## 10. 本地驗證

- `cd site && npm test`：涵蓋 `tests/relay-canonical.test.mjs`、`tests/relay-sign-verify.test.mjs`、`tests/relay-secondary.test.mjs`、`tests/relay-verify.test.mjs`，在同一程序內模擬兩站與 D1，不需要網路。
- 本手冊的 production 驗證只用 GET；不包含對 production 的寫入。
