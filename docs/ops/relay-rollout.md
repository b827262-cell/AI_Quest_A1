# A-01 身分轉送簽章上線手冊（Relay Rollout Runbook）

本手冊是三站運行手冊（`docs/ops/three-site-runbook.md`）的補充，說明次站簽章（PR #57）與主站驗章（PR #58）的上線、驗證、回滾、金鑰輪替與疑難排解。
設計依據為 A-01 三站整合設計文件（該文件在 Project，不在本 repo）；本手冊所有數值一律以程式碼為準，逐項對應見第 9 節。程式碼位置：`site/lib/relay-signature.ts`、`site/lib/relay-verification.ts`、`site/app/api/backend-client.ts`、`site/app/api/auth-helper.ts`、`site/app/api/health/route.ts`、`site/worker/index.ts`、`site/drizzle/0003_superb_purifiers.sql`。

本手冊不提供可直接複製執行的 production 寫入指令；任何對 production 的寫入（部署、migration、變數變更）都必須先取得 Owner 授權。

## 1. 概念與資料流

次站在 production 代理自己的 `/api/<site>/*` 時：

1. 讀入站的 `oai-authenticated-user-id` 與 `oai-authenticated-user-email`（平台在次站入口注入的身分）。
2. 若本站簽章設定有效（見 §1.2），以 `A01_RELAY_SIGNING_KEY` 對 canonical 字串做 HMAC-SHA256，產生 `x-a01-relay-*` 七個標頭：`site`、`ts`、`nonce`、`user-id`、`user-email`、`user-role`、`sig`。
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

`A01_RELAY_MODE` 只在主站判讀。解析規則依程式碼版本而異：

- **目前 main（`9898c1e`，`site/lib/relay-verification.ts:24-29`）**：`undefined`／`null`／`""`／`"off"` → `off`；`"transitional"` → `transitional`；其他任何值 → `strict`。此時**純空白字串（例如 `"  "`）、`OFF`、`Transitional` 都算未識別值，會落到 `strict`**。
- **PR #59（`fix/relay-auth-hardening`，待合併）**：先 `trim()` 再轉小寫；`undefined`／`null` → `off`；非字串 → `strict`；正規化後 `""`／`"off"` → `off`；`"transitional"` → `transitional`；其他 → `strict`。因此**純空白 → `off`、`OFF` → `off`、`Transitional` → `transitional`**。

兩種版本都維持「未識別值一律 `strict`（fail closed）」；差異只在空白與大小寫的正規化。請以實際部署的程式碼版本為準（#59 合併後即為後者）。

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

### 1.2 次站簽章的精確條件

「匿名請求是否仍簽章」與「無簽章能力時的行為」是兩個不同情況，兩者都成立（`site/app/api/backend-client.ts:224-234`、`240-265`；`site/tests/relay-secondary.test.mjs`）：

| 簽章設定（`canSign`） | 入站有無 `oai-*` 身分 | 次站行為 |
| --- | --- | --- |
| 有效（`A01_RELAY_SIGNING_KEY` ≥ 32 且 `A01_RELAY_SITE` == `SITE_NAME`） | 有 | 簽章轉送；`user-id`／`user-email` 為入站值。 |
| 有效 | 無（匿名） | **仍簽章轉送**；`user-id`／`user-email` 以 `-` sentinel 帶入（`relay-secondary.test.mjs` 的 `configured anonymous requests sign missing identity sentinels`）。 |
| 無效（缺鑰／< 32／站別不符） | 有 | 回 `503 {"error":"relay_signing_unavailable"}`，不對外呼叫。 |
| 無效 | 無（匿名） | **不簽章**、不帶任何 `oai-*`／`x-a01-relay-*` 直接轉送；不會回 503。 |

因此：匿名請求在簽章設定有效時仍會被簽成 `-` sentinel；只有在沒有簽章能力時才完全不帶標頭。`canSign` 只看金鑰長度與站別，不看請求是否帶身分。

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

- **兩站金鑰不得相同（跨站）。** `siteKeys` 會拿 student 的每一把與 admin 的每一把互比；只要**任一** student 金鑰等於**任一** admin 金鑰（含現行對現行、現行對 `_PREV`、`_PREV` 對 `_PREV`），兩個站的金鑰清單都會被視為空，所有 relay 驗章一律失敗，`relayKeys` 為 0（`site/lib/relay-verification.ts:37-47`）。
- 金鑰只在長度 ≥ 32 時計入；`_PREV` 與現行金鑰同時存在時，兩把都會被嘗試。
- **`relayKeys` 是綁定項數，不是相異金鑰數。** `configuredKeys` 只是把「現行」與「`_PREV`」兩個綁定過濾後回傳（`site/lib/relay-verification.ts:31-35`），不先去重；因此同站的現行金鑰與 `_PREV` 若設成**相同字串**，會被重複計數（該站算 2）。請避免把兩者設成相同值。
- 本手冊只寫變數名稱，不寫任何值；變數的注入方式見三站運行手冊第 2 節。

## 3. 上線前閘門

以下四項全部通過才可上線；缺一項即暫停。

### (a) staging 實測 O-1a：production 是否剝除外部帶入的 `oai-*`

次站會替「入站的 `oai-*`」簽章。如果外部請求可以直接帶 `oai-*` 打到次站，就等於可以讓次站代簽任何身分；只要該 email 在主站 `ADMIN_EMAILS` 內，就能取得管理員。這是整套機制的安全前提。

**測試必須在 `off` 或 `transitional` 下做，不可在 `strict` 下做。** 因為 `strict` 對「沒有 relay 標頭」的請求一律給 guest（`site/app/api/auth-helper.ts:85-87`），Worker 就算真的收到了偽造的 `oai-*` 也不會採用；此時看到 guest 會被誤判成「平台已剝除標頭」，其實只是 `strict` 忽略了它。

前置：確認 staging 上游不指向 production。

- 以 staging `/api/health` 確認 `role`／`site`／`primaryOrigin` 與 `d1`／`r2`：staging 應為 `standalone` 或獨立 staging 資源、D1／R2 `unbound`，且不得把 `PRIMARY_ORIGIN` 指向 production 主站（`https://ai-quest-a1-backend.b827262.chatgpt.site`）。依既有 staging manifest，staging 為 project `appgprj_6aaeb13a9930819186a64f6420ff65a4`（`role: standalone`、`d1/r2: unbound`），與 production 主站 project `appgprj_6aa80235182c8191a876361138ecbc36` 不同；測試時仍請重新確認，避免 manifest 過時。
- 若 staging 是次站且 `PRIMARY_ORIGIN` 指向 production，**不得**進行此測試。

測法（只在 staging，不碰 production）：

1. 把 staging 的 `A01_RELAY_MODE` 設為 `off`（或 `transitional`），確保 Worker 會讀未簽章的 `oai-*`。
2. 對 staging 的會反映身分的端點（例如 `/api/student/me`）送出帶 `oai-authenticated-user-id`／`oai-authenticated-user-email` 的請求。
3. 判定：
   - 若回應把該偽造 id／email 當成身分（`authenticated: true` 且 `user` 為偽造值）→ 平台**未**在抵達 Worker 前剝除，**O-1a 不通過**；不得進入 `transitional` 或 `strict`。
   - 若回應為 guest／未採用該值 → 平台已剝除（或 Worker 看不到該標頭），O-1a 通過。

替代做法（更直接）：不要依賴授權結果，而是直接確認 Worker 是否看得到該標頭。例如在 staging 以平台請求日誌／Worker 記錄檢視實際抵達 Worker 的 `oai-*`；或在 staging 加一個**暫時性、非 production** 的診斷端點（不屬於本文件 PR 範圍）。重點是區分「標頭沒到 Worker」與「標頭到了但被 `strict` 忽略」。

補充：O-1a 未確認前，`transitional` 同樣有風險，因為 `transitional` 只要驗章通過就會採用身分；因此這項是進入 `transitional` 之前的前置條件。

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
4. **觀察期（`transitional`）**：觀察身分是否正常、401 是否異常；建議至少涵蓋一個時鐘 skew 窗（±300s）加一個部署週期。整體流量的未簽章請求比例**目前無法由程式量測**（見 §4.1），需以平台層請求日誌／分析輔助，或列為 Owner 決定的殘餘風險。
5. **主站切 `strict`**：逐項完成 §4.2 的檢查清單後，才把 `A01_RELAY_MODE` 改為 `strict`（只改變數，不改程式）。

`GET /api/health` 的欄位意義（永遠不輸出金鑰）：

| 欄位 | 意義 |
| --- | --- |
| `relayMode` | 該站目前判讀到的模式：`off`／`transitional`／`strict`。次站通常未設定，回報 `off`。 |
| `relayKeys` | 主站可用的驗章綁定項數（student＋admin 的現行與 `_PREV`，跨站共用衝突後）。`0` 代表沒有任何可用金鑰：未設定、長度 < 32，或兩站共用任一金鑰。永不輸出金鑰本身。注意它**不是相異金鑰數**：同站現行與 `_PREV` 設成相同字串會被重複計數（見第 2 節）。 |
| `relaySeen` | **只代表本次 health 請求**的 relay 驗章結果：`none`（沒有 relay 標頭）／`valid`（驗章通過）／`invalid`（有 relay 標頭但驗章失敗）。不是全站統計，見 §4.1。 |

### 4.1 `relaySeen` 的真實語意與限制

`relaySeen` 是對**本次 `/api/health` 請求**呼叫 `verifyIncomingRelay` 的結果（`site/app/api/health/route.ts:52`），不是任何形式的彙總或計數：

- 主站直打 `/api/health` 通常是 `none`，因為 health 由各站本地回應、不經次站簽章代理。**看到 `none` 不代表全站已無未簽章請求**，只代表這次 health 沒帶 relay 標頭。
- 程式碼**沒有**任何 relay 請求的聚合計數器或指標；`relaySeen` 是唯一的觀測點，而且是 per-request。因此「全站是否已無未簽章請求」**目前無法由程式量測**。
- 要驗證 `valid`／`invalid` 的行為，需在 staging／合成環境主動送帶簽章的請求（`site/tests/relay-verify.test.mjs` 已涵蓋）。
- 整體流量觀察只能靠平台層（Sites／Cloudflare）的請求日誌或分析，這不在程式碼內、本手冊不假設其可用。若無此類觀測，「切 `strict` 時已無未簽章請求」這個前提即無法用數據證明，屬**需 Owner 決定的殘餘風險**（可選：接受風險直接切換、先補觀測再切換，或延後 `strict`）。

### 4.2 切 `strict` 前的檢查清單

- [ ] 三個站（主站＋student＋admin）都已部署含簽章的版本，且各自的執行期變數已設定。
- [ ] 主站 `/api/health`：`relayKeys` ≥ 2（student＋admin 各一把現行金鑰；輪替重疊期為 3 或 4），且不是 0。
- [ ] 主站 `adminAllowlist` 為 `configured`。
- [ ] migration `0003`（`relay_nonces`）已由 Owner 授權套用（見第 3(d) 節）。
- [ ] staging 合成簽章請求：`valid` 被採用、`invalid` 被拒（受保護 API 回 401）。
- [ ] O-1a 已通過，且該測試不是在 `strict` 下做的（見第 3(a) 節）。
- [ ] 已用平台層請求日誌／分析確認（或 Owner 明確接受無法量測）：沒有仍直接打主站受保護 API 的未簽章用戶端流量。**程式本身無聚合計數器，無法提供此證明。**
- [ ] 已確認所有使用者面向的來源是次站；主站頁面若被直接存取，其未簽章 API 呼叫在 `strict` 下會變 guest。
- [ ] 回滾路徑已備妥：主站 `A01_RELAY_MODE` 可即時改回 `transitional`。
- [ ] Owner 已逐站授權此次切換。

其他驗證注意：

- `relayKeys` 的預期值：主站 student＋admin 兩把現行金鑰時為 2；輪替重疊期為 3 或 4；若跨站共用任一金鑰會是 0（視為設定錯誤）；同站現行與 `_PREV` 相同字串會重複計數。
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

對**受保護 API**（會呼叫 `getNormalizedAuth` 並檢查 `relayRejected` 的路由，例如 `/api/student/*`、`/api/admin/*`）而言，relay 驗章失敗一律只回單一 `401 {"error":"unauthorized"}`，不洩漏失敗原因。**`/api/health` 是例外**：health 不走 401 路徑，無論 `relaySeen` 是 `none`／`valid`／`invalid` 都回 `200`，並以 `relaySeen` 回報本次驗章結果（`site/app/api/health/route.ts:52-57`）。診斷請看主站 health 的 `relaySeen` 與次站設定。

| 症狀 | 可能原因 | 檢查與處置 |
| --- | --- | --- |
| 受保護 API 回 401 `{"error":"unauthorized"}`（單一對外錯誤） | relay 驗章失敗：簽章不符、站別不符、時戳超出 ±300s、nonce 重放、path／query／body 被改、金鑰未設或 < 32、兩站共用金鑰、D1 不可用 | 看主站 `relaySeen`；確認次站 `A01_RELAY_SIGNING_KEY`／`A01_RELAY_SITE` 與主站對應金鑰。relay 失敗絕不回退 `oai-*`。 |
| `GET /api/health` 回 `200` 但 `relaySeen: invalid` | health 不走 401 路徑；只表示本次 health 請求帶了 relay 標頭但驗章失敗 | 這是預期行為，不是漏回 401。要驗證受保護 API 的 401 請對 `/api/student/*`／`/api/admin/*` 測試。 |
| 次站回 `503 {"error":"relay_signing_unavailable"}` | 次站缺簽章能力（`A01_RELAY_SIGNING_KEY` 未設／< 32，或 `A01_RELAY_SITE` 與 `SITE_NAME` 不符）**且**請求帶有 `oai-*` 身分 | 補齊次站變數後重新部署。注意：無簽章能力且**匿名**時不會 503，而是不帶任何 `oai-*`／`x-a01-relay-*` 直接轉送（見 §1.2）。 |
| 身分間歇性失效 | 兩站時鐘偏差超過 ±300s | 校正次站與主站（平台）時鐘；確認時間同步。 |
| 非 GET／HEAD 一律 401、GET 正常 | 非 GET 依賴 D1 `relay_nonces`：migration 0003 未套用、D1 binding 缺失或查詢失敗 | 套用 migration 0003（Owner 授權）；確認主站 D1 binding。D1 不可用時一律 401。 |
| 大 body 回 401 而非 413 | 有 relay 標頭時，超過 body 上限（一般 8 MiB／upload 21 MiB）在簽章驗證階段就判 `invalid` | 這是預期行為；請在上游縮小 payload。無 relay 標頭時不走此檢查，平台層可能另有更早的限制。 |
| `relayKeys` 比預期多或少 | 跨站共用任一金鑰 → 兩站皆歸零；同站現行與 `_PREV` 相同字串 → 重複計數；長度 < 32 不計入 | `relayKeys` 是綁定項數，不是相異金鑰數；修正重複或共用設定（見第 2 節）。 |
| admin 路由回 403 | `ADMIN_EMAILS` 未設或該 email 不在 allowlist：已驗章身分只會是 `student` | 設定主站 `ADMIN_EMAILS`；以 health `adminAllowlist=configured` 確認。完全無身分時 admin 路由回 401。 |

## 8. 已知限制與後續

- **`site/app/chatgpt-auth.ts` 仍讀未簽章標頭。** 它直接讀 `oai-authenticated-user-id`／`-email`／`-full-name`，只用於顯示（`getChatGPTUser`）；不得用於授權。授權一律走 `getNormalizedAuth` 與 `ADMIN_EMAILS`。
- **CORS allow-headers 殘留宣告待清理（PR-E）。** `site/app/api/backend-client.ts` 的 `handleCors` 仍在 `Access-Control-Allow-Headers` 宣告 `oai-authenticated-user-*` 系列；這些是瀏覽器端的舊宣告，待 PR-E 清理。
- **主站直打 health 的 `relaySeen` 多為 `none`。** 它只代表本次 health 請求，且程式無聚合計數器；詳見 §4.1。要觀察 `valid` 需在 staging／合成環境送出帶簽章請求。
- **設計文件不在 repo。** A-01 三站整合設計文件在 Project；本手冊以程式碼為準。
- **O-1a 未通過前不得上線。** 見第 3(a) 節。

## 9. 程式碼交叉核對

行號以 main `9898c1e` 為準；PR #59（`fix/relay-auth-hardening`）另行標註。

| 項目 | 值 | 程式碼位置（main `9898c1e`） |
| --- | --- | --- |
| 次站簽章金鑰長度門檻 | ≥ 32 | `site/app/api/backend-client.ts:231` |
| 次站站別必須相符 | `A01_RELAY_SITE === SITE_NAME` | `site/app/api/backend-client.ts:231-232` |
| 次站刪除 `oai-*`／`x-a01-relay-*` | 全部刪除 | `site/app/api/backend-client.ts:213-219` |
| 匿名且簽章有效時仍簽章 | `user-id`／`user-email` 用 `-` sentinel | `site/app/api/backend-client.ts:240,260-261` |
| 匿名且無簽章能力時不帶標頭 | 不簽、不帶 `oai-*`／`x-a01-relay-*` | `site/app/api/backend-client.ts:234,240` |
| 有身分且無簽章能力 | `503 relay_signing_unavailable` | `site/app/api/backend-client.ts:233-234` |
| 次站 signed role 一律 `-` | `-` | `site/app/api/backend-client.ts:252,263` |
| 模式解析（main） | 未設／`null`／空／`off`→`off`；`transitional`→`transitional`；其他（含純空白、`OFF`、`Transitional`）→`strict` | `site/lib/relay-verification.ts:24-29` |
| 模式解析（#59 合併後） | trim＋轉小寫：純空白→`off`、`OFF`→`off`、`Transitional`→`transitional`、非字串→`strict` | `origin/fix/relay-auth-hardening`（`b6b8fb7`）`site/lib/relay-verification.ts` |
| 時鐘偏差 | ±300s | `site/lib/relay-verification.ts:15` |
| 一般 body 上限 | 8 MiB | `site/lib/relay-verification.ts:12` |
| upload body 上限 | 21 MiB | `site/lib/relay-verification.ts:14` |
| nonce 表 | `relay_nonces(nonce PK, expires_at)` | `site/drizzle/0003_superb_purifiers.sql:1-4`、`site/db/schema.ts:112-115` |
| nonce 僅非 GET／HEAD 使用 | GET／HEAD 不寫表 | `site/lib/relay-verification.ts:122` |
| 驗章失敗不回退 `oai-*` | `relayRejected` → 401 | `site/app/api/auth-helper.ts:84`；例 `site/app/api/student/me/route.ts:27-29` |
| health 不走 401 | 一律 200，以 `relaySeen` 回報 | `site/app/api/health/route.ts:27,52-57` |
| 管理員只由 allowlist 決定 | `ADMIN_EMAILS` | `site/app/api/auth-helper.ts:45-50,238-241` |
| health 欄位 | `relayMode`／`relayKeys`／`relaySeen` | `site/app/api/health/route.ts:52,55-56` |
| 兩站金鑰不得相同 | 跨站共用任一即兩站皆空 | `site/lib/relay-verification.ts:37-42` |
| `relayKeys` 為綁定項數 | 同站現行與 `_PREV` 相同會重複計數 | `site/lib/relay-verification.ts:31-35,45-47` |
| 未簽章標頭僅供顯示 | `chatgpt-auth.ts` | `site/app/chatgpt-auth.ts:11-13,21-40` |

## 10. 本地驗證

- `cd site && npm test`：涵蓋 `tests/relay-canonical.test.mjs`、`tests/relay-sign-verify.test.mjs`、`tests/relay-secondary.test.mjs`、`tests/relay-verify.test.mjs`，在同一程序內模擬兩站與 D1，不需要網路。
- 本手冊的 production 驗證只用 GET；不包含對 production 的寫入。
