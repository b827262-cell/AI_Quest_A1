# A-01 身分轉送簽章上線手冊（Relay Rollout Runbook）

本手冊是三站運行手冊（`docs/ops/three-site-runbook.md`）的補充，說明次站簽章（PR #57）與主站驗章（PR #58）的上線、驗證、回滾、金鑰輪替與疑難排解。
設計依據為 A-01 三站整合設計文件（該文件在 Project，不在本 repo）；協定與實作數值以程式碼為準，逐項對應見第 9 節；§4.4 中連續 72 小時、100% 不取樣與 Gate `HOLD` 依 Owner 2026/10/15 決議，300／100／30 的樣本與覆蓋數字為建議值，待 Owner 確認，並非測試已通過的結果。程式碼位置：`site/lib/relay-signature.ts`、`site/lib/relay-verification.ts`、`site/app/api/backend-client.ts`、`site/app/api/auth-helper.ts`、`site/app/api/health/route.ts`、`site/worker/index.ts`、`site/drizzle/0003_superb_purifiers.sql`。

本手冊不提供可直接複製執行的 production 寫入指令；任何對 production 的寫入（部署、migration、變數變更）都必須先取得 Owner 授權。

**2026/10/15 決議狀態：`STRICT_RELEASE_GATE=HOLD`。** PR #61 已合併不代表已部署；三站平台日誌可用性仍為 `BLOCKED`，Strict 切換與正式部署均為 `HOLD`。P1-1 的解法為分站 edge secret 閘（`x-a01-relay-edge-secret`，`A01_RELAY_EDGE_MODE=accept|require`，PR #64）；72 小時計時須待次站已送 secret 且主站 `require` 生效後才起算（見 §4.4）。目前僅授權本文件補強、建立新 PR（禁止直接合併）與唯讀調查；未授權平台設定變更、Staging 部署、D1 migration 或正式上線。以下部署、測試與回滾步驟是取得各項授權後的程序，不構成現在的執行授權。

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

- **舊版（#59 前，`9898c1e`，`site/lib/relay-verification.ts:24-29`）**：`undefined`／`null`／`""`／`"off"` → `off`；`"transitional"` → `transitional`；其他任何值 → `strict`。此時**純空白字串（例如 `"  "`）、`OFF`、`Transitional` 都算未識別值，會落到 `strict`**。
- **本次程式碼基準（`cc05e6e`，含 #59、#61，`site/lib/relay-verification.ts:24-31`）**：先 `trim()` 再轉小寫；`undefined`／`null` → `off`；非字串 → `strict`；正規化後 `""`／`"off"` → `off`；`"transitional"` → `transitional`；其他 → `strict`。因此**純空白 → `off`、`OFF` → `off`、`Transitional` → `transitional`**。

兩種版本都維持「未識別值一律 `strict`（fail closed）」；差異只在空白與大小寫的正規化。本次核對的 main（`cc05e6e`，含 #61）為後者；實際部署版本須另附平台證據。

| 情境 | `off`（含未設定／空字串） | `transitional` | `strict`（含任何未識別值） |
| --- | --- | --- | --- |
| 請求沒有任何 `x-a01-relay-*` | 讀未簽章的 `oai-*`（legacy 行為） | 讀未簽章的 `oai-*`（legacy 行為） | guest；完全不讀 `oai-*` |
| 有 `x-a01-relay-*` 且驗章通過 | 不驗章、忽略 relay 標頭；由於次站已刪除 `oai-*`，通常變成 guest | 採用簽章 userId／email 為身分 | 同 `transitional` |
| 有 `x-a01-relay-*` 但驗章失敗 | 不驗章、忽略 relay 標頭，改依 legacy `oai-*` 判斷（沒有則 guest） | 回 `relayRejected` → `401 {"error":"unauthorized"}`，**不回退** `oai-*` | 同 `transitional` |
| 有 `x-a01-relay-*` 但 edge secret 缺失／錯誤（僅 `require`；D9=B） | 剝除 relay／`oai-*` 後依該模式判斷（通常 guest） | 剝除後視同無身分 → guest | 同 `transitional` |
| 簽章 role 是否授權 | 不適用 | 否 | 否 |

重點：

- **未識別值一律 `strict`**，不會靜默退回 `off` 或 `transitional`。
- **relay 標頭驗章失敗不得回退到 `oai-*`**：只要請求帶了 `x-a01-relay-*` 且**通過 edge 閘後**驗章失敗，`transitional`／`strict` 都直接回 401，不會改讀未簽章的 `oai-*`。edge 閘 `require` 下，缺少／錯誤 secret 的請求已在進驗章前被剝除並靜默忽略（見上表與 §4.4），不適用本條。
- `off` 是舊行為：它不驗章，也不認識 relay 標頭。次站一旦開始簽章（步驟 3 會刪除 `oai-*`），主站若仍在 `off`，身分會掉成 guest。因此上線順序必須先讓主站進入 `transitional`，再部署次站。
- **Edge secret 閘（D9=B，PR #64）：** 主站在 `gateApiRequest` 之後另有 `A01_RELAY_EDGE_MODE=accept|require` 的分站 edge secret 檢查（`x-a01-relay-edge-secret`）。`accept`（預設）只記 `relay.probe`、其餘行為不變；`require` 下缺少或錯誤 secret 的請求不進 relay 驗章、改記 `relay.probe` 並剝除 `x-a01-relay-*`／`oai-*`，不產生 `invalid`。模式解析為「未設定→`accept`、無法辨識→`require`（fail closed）」，secret 有效長度 32–512，跨站重用會讓兩站同時失效；`require` 下直連主站 admin／student 會 lockout。完整規則見 §1.3，驗收與觀測見 §4.4、§6.1。

### 1.2 次站簽章的精確條件

「匿名請求是否仍簽章」與「無簽章能力時的行為」是兩個不同情況，兩者都成立（`site/app/api/backend-client.ts:226-236`、`242-278`；`site/tests/relay-secondary.test.mjs`）：

| 簽章設定（`canSign`） | 入站有無 `oai-*` 身分 | 次站行為 |
| --- | --- | --- |
| 有效（`A01_RELAY_SIGNING_KEY` ≥ 32 且 `A01_RELAY_SITE` == `SITE_NAME`） | 有 | 簽章轉送；`user-id`／`user-email` 為入站值。 |
| 有效 | 無（匿名） | **仍簽章轉送**；`user-id`／`user-email` 以 `-` sentinel 帶入（`relay-secondary.test.mjs` 的 `configured anonymous requests sign missing identity sentinels`）。 |
| 無效（缺鑰／< 32／站別不符） | 有 | 回 `503 {"error":"relay_signing_unavailable"}`，不對外呼叫。 |
| 無效 | 無（匿名） | **不簽章**、不帶任何 `oai-*`／`x-a01-relay-*` 直接轉送；**不會僅因缺少簽章能力而回 `relay_signing_unavailable`**（但 body 讀取／簽章在 `try` 內拋錯仍會由 catch 回 503，見下）。 |

因此：匿名請求在簽章設定有效時仍會被簽成 `-` sentinel；只有在沒有簽章能力時才完全不帶標頭。`canSign` 只看金鑰長度與站別，不看請求是否帶身分。

例外：`delegateToBackend` 把「非 GET／HEAD 讀 body」與簽章放在同一個 `try`（`site/app/api/backend-client.ts:238-282`）。非 GET／HEAD 讀 body 失敗（或簽章過程拋錯）時，即使是匿名請求也會由 `catch` 回 `503 {"error":"relay_signing_unavailable"}`。所以「匿名不會 503」的準確說法是「**不會僅因缺少簽章能力而 503**」。

### 1.3 Edge secret 閘的解析與有效性（D9=B，PR #64／#67）

主站在既有路徑／拓樸閘（`gateApiRequest`）之後、relay 驗章之前，對非 `/api/health` 的 API 路徑做分站 edge secret 檢查：`gatePrimaryApiRequest` 先做路徑與拓樸判定，再呼叫 `gateRelayEdgeRequest`（`site/lib/relay-edge-gate.ts:95-123`）。規則以程式碼為準。

**模式解析（`readEdgeGateMode`，`site/lib/relay-edge-gate.ts:14-19`）：**

- `undefined`／`null` → `accept`（未設定＝沿用既有行為，**不會**自動變成 `require`）。
- 非字串 → `require`。
- 字串先 `trim()` 再轉小寫；正規化後 `""`／`"accept"` → `accept`；其他任何值 → `require`。

因此**未設定＝`accept`，無法辨識的值一律 `require`（fail closed）**：`"require"`、`"REQUIRE"`、`" require "` 皆為 `require`；拼錯的值（例如 `"requrie"`）也會落到 `require`，不會靜默退回 `accept`。反過來說，未設定不會自動升級為嚴格閘，**啟用嚴格閘必須明確設定 `A01_RELAY_EDGE_MODE=require`，不得假設預設即為 `require`**。

**secret 有效性（`usableSecret`，`site/lib/relay-edge-gate.ts:33-35`）：**

- edge secret 必須是字串且長度介於 **32–512 字元（含端點）**；`< 32`、`> 512`、非字串或未設定者一律視為無效，等同未設定。
- 無效值不匹配也不計數：主站閘不採用（`require` 下落 `relay.probe`），次站不送出該 header（`site/app/api/backend-client.ts:275`），health 的 `edgeSecrets` 也不計入。
- 與 relay 驗章金鑰不同：驗章金鑰只有 `≥ 32` 下限、沒有上限（`site/lib/relay-verification.ts:36`）；32–512 的上下限只適用於 edge secret。

**跨站重複 secret 會讓兩站同時失效：**

- `validSecrets` 會把 student 的每一把與 admin 的每一把互比（含現行對現行、現行對 `_PREV`、`_PREV` 對 `_PREV`）；只要**任一** student secret 等於**任一** admin secret，兩站的 secret 清單都會被視為空（`site/lib/relay-edge-gate.ts:37-42`）。
- 後果：`require` 下所有帶 secret 的請求都不匹配，一律記 `relay.probe` 並剝除 `x-a01-relay-*`／`oai-*`，使用者掉成 guest／401；health 的 `edgeSecrets` 兩站皆為 `0`、`edgeSecretsDistinct=false`（`site/lib/relay-edge-gate.ts:51-59`）。**兩站 secret 必須互不相同，`_PREV` 也不得跨站重用。**

**`require` 下的直連主站禁令（lockout 風險）：**

- `require` 生效時，**不得讓使用者直接命中主站的 admin／student API**（不經次站代理、因而沒有 `x-a01-relay-edge-secret`）。主站會先剝除 `x-a01-relay-*`／`oai-*`，請求在 `transitional`／`strict` 下視同無身分：`/api/admin/*` 回 401、`/api/student/*` 掉成 guest，使用者會被鎖在門外（lockout）。
- 所有使用者面向入口（主站頁面、書籤、直接連結與任何繞過次站的呼叫）都必須確認改走次站；主站頁面本身若被直連，其未簽章 API 呼叫在 `require`／`strict` 下同樣失效。此項須在切 `require` 前完成盤點與驗證（見 §4.2）。

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
| 主站 | `A01_RELAY_EDGE_MODE` | 啟用 edge 閘時必填 | `accept`（預設）／`require`。未設定／空字串＝`accept`；非字串或無法辨識的值（含拼錯）＝`require`（fail closed，見 §1.3）。`require` 下僅接受帶正確分站 edge secret 的請求進入 relay 驗章；未設定不會自動變成 `require`（不得假設預設即為 `require`）。 |
| 主站 | `A01_RELAY_EDGE_SECRET_STUDENT` | 啟用閘就必填 | 學生次站的 edge secret；與 relay 驗章金鑰分開。 |
| 主站 | `A01_RELAY_EDGE_SECRET_STUDENT_PREV` | 輪替時使用 | 學生次站的舊 edge secret；重疊期與現行並存，兩把都接受。 |
| 主站 | `A01_RELAY_EDGE_SECRET_ADMIN` | 啟用閘就必填 | 管理次站的 edge secret；與 relay 驗章金鑰分開。 |
| 主站 | `A01_RELAY_EDGE_SECRET_ADMIN_PREV` | 輪替時使用 | 管理次站的舊 edge secret；重疊期與現行並存，兩把都接受。 |
| 次站 | `A01_RELAY_EDGE_SECRET_STUDENT`（student 站）／`A01_RELAY_EDGE_SECRET_ADMIN`（admin 站） | 要送 secret 就必填 | 隨簽章請求送出 `x-a01-relay-edge-secret`（#65 已合併）：student 站讀前者、admin 站讀後者。只送當前值、不送 `_PREV`；僅 `canSign` 時送；缺失或長度不在 32–512 時不送（行為同現狀，不拋錯、不記錄值）。 |
| 主站 | `ADMIN_EMAILS` | 必填 | 管理員 allowlist，與簽章無關；簽章只決定身分，不決定管理員。 |

規則：

- **兩站金鑰不得相同（跨站）。** `siteKeys` 會拿 student 的每一把與 admin 的每一把互比；只要**任一** student 金鑰等於**任一** admin 金鑰（含現行對現行、現行對 `_PREV`、`_PREV` 對 `_PREV`），兩個站的金鑰清單都會被視為空，所有 relay 驗章一律失敗，`relayKeys` 為 0（`site/lib/relay-verification.ts:39-49`）。
- 金鑰只在長度 ≥ 32 時計入；`_PREV` 與現行金鑰同時存在時，兩把都會被嘗試。
- **`relayKeys` 是綁定項數，不是相異金鑰數。** `configuredKeys` 只是把「現行」與「`_PREV`」兩個綁定過濾後回傳（`site/lib/relay-verification.ts:33-37`），不先去重；因此同站的現行金鑰與 `_PREV` 若設成**相同字串**，會被重複計數（該站算 2）。請避免把兩者設成相同值。
- edge secret 與 relay 驗章金鑰分開；edge secret 有效長度為 **32–512 字元**（`site/lib/relay-edge-gate.ts:33-35`），超出範圍視同未設定。relay 驗章金鑰只有 `≥ 32` 下限（`site/lib/relay-verification.ts:36`），兩者規則不同。
- **兩站 edge secret 不得相同（跨站）：** 只要 student 任一 secret 等於 admin 任一 secret（含 `_PREV`），兩站 secret 清單都失效；`require` 下所有請求落入 `relay.probe` 並被剝除，health `edgeSecrets` 兩站皆 `0`、`edgeSecretsDistinct=false`（`site/lib/relay-edge-gate.ts:37-42,51-59`）。同站 `_PREV` 與現行設成相同字串不影響有效性，但會讓 health 計數重複（同 relay 金鑰模式）。詳見 §1.3。
- 本手冊只寫變數名稱，不寫任何值；變數的注入方式見三站運行手冊第 2 節。

## 3. 上線前閘門

以下四項全部通過才可上線；缺一項即暫停。

### (a) staging 實測 O-1a：production 是否剝除外部帶入的 `oai-*`

次站會替「入站的 `oai-*`」簽章。如果外部請求可以直接帶 `oai-*` 打到次站，就等於可以讓次站代簽任何身分；只要該 email 在主站 `ADMIN_EMAILS` 內，就能取得管理員。這是整套機制的安全前提。

**測試必須在 `off` 或 `transitional` 下做，不可在 `strict` 下做。** 因為 `strict` 對「沒有 relay 標頭」的請求一律給 guest（`site/app/api/auth-helper.ts:117-119`），Worker 就算真的收到了偽造的 `oai-*` 也不會採用；此時看到 guest 會被誤判成「平台已剝除標頭」，其實只是 `strict` 忽略了它。

前置 1：確認 staging 上游不指向 production。

- 以 staging `/api/health` **實測**確認 `role`／`site`／`primaryOrigin` 與 `d1`／`r2`：staging 應為 `standalone` 或獨立 staging 資源、D1／R2 `unbound`，且不得把 `PRIMARY_ORIGIN` 指向 production 主站（`https://ai-quest-a1-backend.b827262.chatgpt.site`）。
- 注意：既有 staging manifest 記為 `health_status: not_configured`、`worker.bindings: {}`；其中 `standalone`／`unbound` 來自較早的 recapture，**尚未經 live health 實測確認**。因此在進行 O-1a 之前，**必須先完成 staging `/api/health` 實測**並記錄結果。manifest 的 project 差異（staging `appgprj_6aaeb13a9930819186a64f6420ff65a4` vs production 主站 `appgprj_6aa80235182c8191a876361138ecbc36`）只能當線索，不能當已驗證事實。
- 若 staging 是次站且 `PRIMARY_ORIGIN` 指向 production，**不得**進行此測試。

前置 2：確認 staging 與 production 的 ingress（外部 `oai-*` 處理）行為等價。

- **只有當 staging 與 production 的邊緣／ingress 對「外部帶入的 `oai-*`」處理方式等價時，staging 的 O-1a 結果才能作為 production 的閘門證據**；否則 staging 通過不能推論 production 通過。
- 如何確認等價：比對兩個 project 的 hosting／edge 設定（同一個 Sites runtime、同一套身分注入與標頭剝除設定、相同的中介層／自訂網域），並確認兩者沒有不同的平台設定或額外 proxy。可由平台維運／Owner 提供設定對照，或以兩邊設定快照比對。
- 若無法確認等價：保持 `HOLD`，由 Owner／平台負責人補足設定對照或另行授權驗證 production ingress；不得把 staging 通過直接記為 production 通過。

測法（只在 staging，不碰 production）：

1. 把 staging 的 `A01_RELAY_MODE` 設為 `off`（或 `transitional`），確保 Worker 會讀未簽章的 `oai-*`。
2. 對 staging 的會反映身分的端點（例如 `/api/student/me`）送出帶 `oai-authenticated-user-id`／`oai-authenticated-user-email` 的請求。
3. 判定：
   - 若回應把該偽造 id／email 當成身分（`authenticated: true` 且 `user` 為偽造值）→ 平台**未**在抵達 Worker 前剝除，**O-1a 不通過**；不得進入 `transitional` 或 `strict`。
   - 若回應為 guest／未採用該值 → 平台已剝除（或 Worker 看不到該標頭），O-1a 通過。

替代做法（更直接）：不要依賴授權結果，而是直接確認 Worker 是否看得到該標頭。例如在 staging 以平台請求日誌／Worker 記錄檢視實際抵達 Worker 的 `oai-*`；或在 staging 加一個**暫時性、非 production** 的診斷端點（不屬於本文件 PR 範圍）。重點是區分「標頭沒到 Worker」與「標頭到了但被 `strict` 忽略」。

補充：O-1a 未確認前，`transitional` 同樣有風險，因為 `transitional` 只要驗章通過就會採用身分；因此這項是進入 `transitional` 之前的前置條件。本項及後續所有「未簽章」量測，範圍須依 §4.4 的 Owner 驗收規則第 2 條涵蓋直連主站與任何繞過 relay 的入口，不得只量次站來源。

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
4. **觀察期（`transitional`）**：先完成 §4.4 的平台管線驗證，再累計連續 72 小時的乾淨視窗；兩站有效樣本、逐路徑讀寫覆蓋須待 Owner 確認建議值後達標，日誌完整性及回滾演練亦須通過。單純經過 72 小時或沒有日誌，不算通過。
5. **主站切 `strict`**：§4.2、§4.4 全部通過並取得 Owner 此次切換授權後，設定主站 `A01_RELAY_MODE=strict` 並重新部署；核驗部署版本、生效設定、health 與兩站合法請求。設定值變更本身不代表部署完成。

`GET /api/health` 的欄位意義（永遠不輸出金鑰或 secret 值；#67 後另含唯讀 edge 閘觀測，**僅計數與布林**）：

| 欄位 | 意義 |
| --- | --- |
| `relayMode` | 該站目前判讀到的模式：`off`／`transitional`／`strict`。次站通常未設定，回報 `off`。 |
| `relayKeys` | 主站可用的驗章綁定項數（student＋admin 的現行與 `_PREV`，跨站共用衝突後）。`0` 代表沒有任何可用金鑰：未設定、長度 < 32，或兩站共用任一金鑰。永不輸出金鑰本身。注意它**不是相異金鑰數**：同站現行與 `_PREV` 設成相同字串會被重複計數（見第 2 節）。 |
| `relaySeen` | **只代表本次 health 請求**的 relay 驗章結果：`none`（沒有 relay 標頭）／`valid`（驗章通過）／`invalid`（有 relay 標頭但驗章失敗）。不是全站統計，見 §4.1。 |
| `edgeMode` | 主站目前判讀到的 edge 閘模式：`accept`／`require`（`site/lib/relay-edge-gate.ts:14-19`）。未設定回報 `accept`。 |
| `edgeSecrets` | `{ student, admin }`，分別為該站可用 edge secret 的**綁定項數**（現行＋`_PREV`，跨站共用衝突後）。`0` 代表該站沒有可用 secret：未設定、長度不在 32–512，或跨站重用任一 secret 導致兩站皆失效。**只輸出計數**，永不輸出值、長度、前綴或雜湊。 |
| `edgeSecretsDistinct` | 布林：student 與 admin 的可用 secret 是否互不重複。`false` 代表跨站重用、兩站 secret 皆失效（見 §1.3）。**只輸出布林**。 |

#67 的 health 欄位與 `relaySeen` 一樣只是唯讀觀測：health 仍豁免 edge 閘（`site/lib/relay-edge-gate.ts:121`）且不寫 `relay.verify`；`edgeSecrets`／`edgeSecretsDistinct` 不得當作 Gate 通過依據，只能輔助確認 `require` 是否生效與 secret 是否被跨站重用。

### 4.1 `relaySeen` 的真實語意與限制

`relaySeen` 是對**本次 `/api/health` 請求**呼叫 `verifyIncomingRelay` 的結果（`site/app/api/health/route.ts:65`），不是任何形式的彙總或計數：

- 主站直打 `/api/health` 通常是 `none`，因為 health 由各站本地回應、不經次站簽章代理。**看到 `none` 不代表全站已無未簽章請求**，只代表這次 health 沒帶 relay 標頭。
- PR #61 在主站 `getNormalizedAuth` 路徑加入 `relay.verify` 應用日誌；程式仍沒有全站聚合計數器。是否已部署、平台是否完整保存及可查詢，必須依 §4.4 取得實測證據。
- 日誌僅在 `SITE_ROLE=primary` 且模式為 `transitional`／`strict` 時產生；同一 `Request` 最多一筆，在驗章（含非 GET／HEAD 的 nonce 判定）完成後記錄。
- `off`、health、gate、CORS 提前拒絕、次站 delegate 及未經 `getNormalizedAuth` 的路徑沒有這筆應用日誌，必須另外核對平台 invocation logs；edge 閘擋下的請求另記 `evt=relay.probe`（D9=B）。
- `relaySeen` 不可代替聚合統計；缺少平台證據或無法量測即 `HOLD`，不得以接受殘餘風險、零筆日誌或單一 health 成功取代 Strict Gate。
- **Edge 閘豁免 health，故 `relaySeen=invalid` 可被外部製造（D9=B）：** `/api/health` 不經 edge 閘，任何外部請求帶偽造 `x-a01-relay-*` 打主站 health 都能讓該次 `relaySeen` 為 `invalid`；health 也不寫 `relay.verify`。故此值**不得作為 Gate 通過或回滾的依據**。

### 4.2 切 `strict` 前的檢查清單

- [ ] 三個站（主站＋student＋admin）都已部署含簽章的版本，且各自的執行期變數已設定。
- [ ] 主站 `/api/health`：`relayKeys` ≥ 2，且不是 0。**這只是總量檢查，不能證明 student 與 admin 各自有有效金鑰**（例如 student 現行＋student `_PREV`、admin 無鑰時，總數仍是 2）。
- [ ] **另行獨立確認 student 與 admin 各自至少有一把有效金鑰**（health 沒有分站金鑰數欄位，必須另外做）：(1) 由 Owner 檢視主站執行期綁定，確認 `A01_RELAY_KEY_STUDENT` 與 `A01_RELAY_KEY_ADMIN` 皆存在、長度 ≥ 32、互不相等；(2) 兩站各做一次有效簽章 smoke check（見 §4.3）。兩項都需 Owner 授權，本手冊不提供可直接複製執行的 production 指令。
- [ ] 主站 `adminAllowlist` 為 `configured`。
- [ ] migration `0003`（`relay_nonces`）已由 Owner 授權套用（見第 3(d) 節）。
- [ ] staging 合成簽章請求：`valid` 被採用、`invalid` 被拒（受保護 API 回 401）。
- [ ] O-1a 已通過，且該測試不是在 `strict` 下做的（見第 3(a) 節）。
- [ ] edge secret 閘已部署並驗證：次站已送 `x-a01-relay-edge-secret`（#65 已合併），主站 `A01_RELAY_EDGE_MODE=require` 生效，且 `require` 下缺失／錯誤 secret 記為 `relay.probe`、不產生 `invalid`（PR #64）。主站 health 須回報 `edgeMode=require`、`edgeSecrets.student` 與 `edgeSecrets.admin` 皆 ≥ 1、`edgeSecretsDistinct=true`（#67；僅計數／布林，見 §1.3、第 4 節）。
- [ ] §4.4 全部達標：三站平台證據齊全、100% 日誌、連續 72 小時、雙站樣本與寫入覆蓋的建議值經 Owner 確認後達標、零異常、完整性及隱私檢查通過；建議值未確認即 `HOLD`。
- [ ] 已確認所有使用者面向的來源是次站，且 `require` 下**沒有**直連主站 admin／student API 的路徑（主站頁面、書籤、直接連結、外部整合皆改走次站）；否則該類請求會被剝除身分而 lockout（`/api/admin/*` 401、`/api/student/*` guest，見 §1.3）。
- [ ] §5 的回滾門檻、基準、執行者與部署權限已確認，且 staging 回滾演練為 `PASS`。
- [ ] AGY 已獨立審查本 Runbook PR；Hermes 已整合平台證據與審查結果回報 Gate 結論，並交 Owner 決定。
- [ ] Owner 已逐站授權此次切換。

其他驗證注意：

- `relayKeys` 的預期值：主站 student＋admin 兩把現行金鑰時為 2；輪替重疊期為 3 或 4；若跨站共用任一金鑰會是 0（視為設定錯誤）；同站現行與 `_PREV` 相同字串會重複計數。
- health 是 GET，不寫 nonce；非 GET 的 D1 nonce 路徑請在 staging／測試驗證，不對 production 做寫入。

### 4.3 兩站各自的有效簽章 smoke check

目的：`relayKeys` 只是總數，無法區分是哪一站的金鑰；本節補足「student 與 admin 各自有有效金鑰」的確認。方法如下（只描述；實際執行需 Owner 逐站授權，本手冊不提供可直接複製執行的 production 指令）。

**共同前提：** 對各次站發出一次**帶平台身分**的 GET，並要求回應同時滿足 (i) 帶 `x-data-plane: primary`（證明確實經由次站代理、有走 relay 路徑；此標頭由 `site/app/api/backend-client.ts:299` 在代理取回主站回應時加上，401／403 也會帶），以及 (ii) 下列端點特定的預期回應。**只有「(i)＋(ii) 都成立」才算成功；其餘一律不算成功。**

正向判定（成功條件）：

- **student**：`GET /api/student/me` 回 **200**，且 body 為 `authenticated: true`、`user` 反映預期的登入身分（`site/app/api/student/me/route.ts:38-53`）。注意 guest 也是 200 但 body 為 `authenticated: false, guest: true`（`:56-67`），**guest 不算成功**（代表沒有可驗證的身分送到主站）。
- **admin**：`GET /api/admin/auth/me` 回 **200**（body `authenticated: true, role: "admin"`，`site/app/api/admin/auth/me/route.ts:51-63`），**或**回 **403** 且 body 為 `authenticated: true`、`error: "admin permission required"`（`:44-49`；代表身分已被主站採用、只是不在 `ADMIN_EMAILS`，與金鑰有效性無關）。

非成功判定：

- **401**（`unauthorized`／`malformed_auth`／`admin authentication required`；`student/me/route.ts:27-36`、`admin/auth/me/route.ts:26-42`）：視為 **relay／身分驗證失敗「待診斷」**，不得直接歸因金鑰。可能原因包含金鑰不符、時戳超出 ±300s、nonce 重放、path／query／body 被改、D1 不可用等（見第 7 節）。
- **其他任何狀態一律判為「未能驗證」、不得算成功**，包含：
  - `503 backend_unavailable`（主站不可達；`site/app/api/backend-client.ts:306-314`，無 `x-data-plane`）；
  - `503 relay_signing_unavailable`（次站缺簽章能力）；
  - `503 backend_disabled`（次站未設定 `PRIMARY_ORIGIN`；`site/app/api/backend-client.ts:192-199`）；
  - **CORS 403** `{"error":"cors_forbidden"}`（`admin/auth/me/route.ts:16-18`、`student/me/route.ts:17-19`；這是來源被拒，不是金鑰有效）；
  - 其他非預期的 403、5xx，或 200 但 body 不符上述正向條件（例如 guest 200）。

輔助對照：在 staging／合成環境以錯誤金鑰簽章，確認受保護 API 回 401（`tests/relay-verify.test.mjs` 已涵蓋），用來確認正向判定不是因為驗章根本沒生效。

使用者失敗率：上述 `503 relay_signing_unavailable`（次站缺簽章能力）與 `require` 下因缺 edge secret 被剝除身分而造成的 guest／401，都屬使用者面向失敗，須依 §4.4 Owner 驗收規則第 4 條計入失敗率、標記原因並跨站去重。

逐站判定：student 與 admin 各自獨立套用上述規則；任一站未達正向條件即該站「未能驗證」，不可用另一站的結果推論。

限制：staging／合成環境的結果須明確標示環境，不得代替 production 雙站證據。若尚無授權或無法取得 production 各次站的有效身分請求，相關驗收保持 `HOLD`。單次 smoke check 不取代 §4.4 的樣本與覆蓋門檻。

### 4.4 Strict Release Gate（Owner 已決事項與待確認建議值）

#### 平台證據與管線預檢（P0）

平台負責人須分別提供主站、Student、Admin 的設定截圖或可核驗唯讀設定證據：實際 runtime／project／Worker 識別、部署 commit／版本、Observability 開關、應用與 invocation 日誌的取樣率、讀取權限、保留期、攝取延遲、費率／方案限制及原始 JSON 查詢方式。Workers Logs 為短期首選，長期匯出另行評估；不得假設 Sites 帳號已具備 Cloudflare 日誌或 Logpush 的權限與能力。依新制規劃預算不代表預先授權付費，亦不可用單行應用 JSON 大小當作平台總計費資料量。平台原生 invocation metadata 受平台 RBAC 控管；作為 Gate 證據對外匯出前須先脫敏（遮罩 IP、query、路徑實體 ID）。

PR #61 實際輸出為 `console.log(JSON.stringify(event))`，不能假設 `result` 等欄位已自動索引。必須在經授權的 staging 驗證：

1. 刻意產生 `invalid`（受保護 API，不能只測 health），證明回應拒絕且原始日誌確實記錄 `result=invalid`；另以合法與無 relay 標頭請求驗證 `valid`／`none` 及 `identityPresent` 判讀。
2. 留存實際可重跑的查詢或唯讀匯出／解析步驟，能依 `result`、`site`、`mode`、`identityPresent`、`method`、`pathClass` 篩選、分組計數；核對平台原始記錄、解析筆數及解析失敗筆數。只有「看得到一行」不算完成，解析失敗不得直接丟棄。平台原始記錄僅在平台權限控管下核對；對外分享／匯出前須先脫敏。
3. 證明三站的 invocation logs 可用、應用及平台採集皆為 100%（不取樣），且保留期／經核准的證據保存方式足以重查完整 72 小時；若有配額、截斷、查詢筆數上限或延遲，須核對分頁／完整匯出後的總數；匯出證據須先脫敏；edge 閘的 `relay.probe` 亦須 100% 採集並可查詢。
4. 將刻意異常的預檢時間與記錄獨立留存；預檢結束、管線驗證通過後，才記錄乾淨觀察視窗的起點。不得在乾淨視窗內刪除或事後排除 `invalid`。
5. **Edge secret 閘（D9=B）須先部署並驗證（PR #64）：** P1-1 的解法是分站 edge secret header（`x-a01-relay-edge-secret`；主站綁定 `A01_RELAY_EDGE_SECRET_STUDENT`／`A01_RELAY_EDGE_SECRET_ADMIN`（＋`_PREV`），模式 `A01_RELAY_EDGE_MODE=accept|require`）。72 小時計時只能在「次站已隨簽章請求送出 secret（#65 已合併）且主站 `A01_RELAY_EDGE_MODE=require` 已部署並驗證生效」之後起算；在此之前 Gate 維持 `HOLD`。`require` 下，缺少或錯誤 secret 的請求不進 relay 驗章、以 `evt=relay.probe` 記錄（不含敏感資料、不含 IP／query／完整路徑），且不計入 `invalid` 零容忍；secret 相符但簽章失敗仍為 `invalid`。

上述是未來經授權的驗證程序，本 PR 不部署 staging、不製造平台流量，也不修改日誌程式或平台設定。證據尚缺即 `BLOCKED`／Gate `HOLD`。

#### 連續觀察的驗收條件（樣本數待 Owner 確認）

以下各項為 AND 條件，兩個次站分別驗收；時間採同一連續視窗，記錄 ISO 8601 起訖時間與時區。Owner 已決事項為連續 72 小時、100% 不取樣及 Gate `HOLD`；72 小時計時須在次站已送 edge secret 且主站 `A01_RELAY_EDGE_MODE=require` 已部署並驗證生效後才起算；有效樣本 300／100 與逐路徑／方法 30 次均為建議值，待 Owner 確認，未確認即 `HOLD`。不得合併不同環境、版本或不連續區間湊滿門檻。

| 指標 | 驗收門檻與計數口徑 |
| --- | --- |
| 觀察時間 | 管線預檢後，且次站已送 edge secret、主站 `A01_RELAY_EDGE_MODE=require` 已部署並驗證生效後，才起算連續 72 小時，主站 `transitional`；平台資料到齊後才結算。起算時須記錄候選版本（commit sha）、三站生效設定與站點範圍（§4.4 Owner 驗收規則第 3 條）。 |
| 日誌取樣 | 應用及三站相關平台採集均 100%，不取樣。 |
| `invalid` | 完整觀察範圍內 `evt=relay.verify AND result=invalid` 為 0；包含 `site=unknown`／`pathClass=other`，無未經證實的例外。在 `require` 下，缺少或錯誤 edge secret 的請求不進 relay 驗章，改記 `evt=relay.probe`，不計入本項零容忍；secret 相符但簽章失敗仍為 `invalid`。 |
| 異常身分組合 | `result=none AND identityPresent=true` 為 0；其他無法解釋的站別／路徑／身分組合亦須先解決，不得自動排除。 |
| 有效樣本 | 建議值，待 Owner 確認：`result=valid AND site=student` ≥300；`result=valid AND site=admin` ≥100，並分列 GET／HEAD／OTHER 與路由模板。`none`、health、gate、CORS 拒絕不計入。 |
| 讀寫覆蓋 | 兩站均有帶平台身分的成功 GET（§4.3）；每站每個適用的非 GET 業務路徑／方法至少 30 次成功驗證（建議值，待 Owner 確認）。每次須有 `valid` 及預期授權／業務成功回應；匿名簽章或 HTTP 200 本身不能證明合法使用者成功。 |
| 未分類受保護路徑 | 0 個未解決；`pathClass=other` 先核對完整路由表，受保護者必須納入。 |
| 日誌完整性 | 與符合記錄條件的主站請求數逐區間核對，無未解釋缺口／重複／解析失敗；另完成無應用日誌路徑的 invocation 核對。 |
| 敏感資訊外洩 | 0（分兩類）。(1) 應用 console 日誌（`relay.verify`、`relay.probe`）與對外分享／匯出的稽核證據：不得含金鑰、簽章、nonce、email、user-id、Authorization、cookie、IP、含 ID 的完整路徑與查詢字串；不為核對而加記敏感欄位。(2) Cloudflare 平台原生 invocation metadata：本身含 URL 與連線 IP，另列並受平台權限控管，不得外洩給未授權接收端；作為 Gate 證據對外匯出前須先脫敏（遮罩 IP、query、路徑實體 ID）。 |
| 回滾演練 | 經授權的 staging 完成 §5 全流程並記為 `PASS`，附部署與合法請求恢復證據。 |

最低樣本數是工程建議值，待 Owner 確認，不代表統計上證明異常率為零；未確認即 Gate `HOLD`。72 小時到期但任一站未達 Owner 確認後的門檻，即 `INSUFFICIENT_SAMPLE`／Gate `HOLD`；持續觀察，選取同一連續且至少 72 小時的完整乾淨視窗重新結算，不得把低流量當成功。補樣只能使用另行授權、可辨識的測試流量，與真實流量分列；staging 樣本不得混入 production 計數。

若視窗內出現異常、日誌缺口、採集失效或候選版本／相關設定變更，立即暫停晉級並保留原視窗證據；edge 閘擋下的 `relay.probe` 不觸發重新起算，但須保留並計數。調查修復、重新驗證管線後，重新起算 72 小時；不得拼接前後區間，或直接豁免已出現的 `invalid`。

#### Owner 已採納的四條驗收規則

以下四條為 Owner 已採納的驗收規則，適用於本 Runbook 的所有 Gate 結論與交接，與前述門檻並行；四條都不改變 300／100／30 等建議值與 §5 的回滾數字（仍為提案狀態，待 Owner 確認）。

1. **逐一合併並對更新後 main 重驗；`PASS` 對應實際 head。** 每個 PR 單獨合併，不得批次或交叉合併後再補驗；每次合併後必須在**更新後的 main** 重新驗證（重跑本地測試、重算行號與引用、重做受影響的量測），不得沿用合併前或前一顆 head 的結果。任何 `PASS` 結論都必須綁定當時**實際的 head commit sha** 並寫入交接記錄；不得以「大致相同」或跨 PR 推定代替。
2. **未簽章量測須涵蓋直連主站與繞過 relay 的入口。** 未簽章（無 `x-a01-relay-*`）請求的計數與量測，必須同時涵蓋 (a) 直連主站、不經次站代理的請求，以及 (b) 任何繞過 relay 的入口（例如直接命中主站 API、非次站代理路徑、edge 閘豁免的 health 等）。只量次站來源會低估未簽章流量；量測範圍須在候選版本的路由盤點中明列，無法區分即 `HOLD`。
3. **72 小時窗口須明定起算版本／設定／站點，影響驗章或量測的變更後重評。** 每個觀察窗口都必須記錄起算時的候選版本（commit sha）、三站生效設定（`A01_RELAY_MODE`、`A01_RELAY_EDGE_MODE`、金鑰／secret 綁定版本）與站點範圍。任何會影響驗章或量測的變更（程式碼、執行期變數、路由、日誌程式或採集設定）之後，該窗口即失效，必須重新驗證管線並重新起算；不得沿用舊窗口的 72 小時。
4. **次站缺 secret 的使用者失敗（含 `503`）計入使用者失敗率、標原因、跨站去重。** 次站因缺少 edge secret 而無法完成使用者請求者一律計入**使用者面向失敗率**，不得只算主站 `relay.verify` 的 `invalid`。依現行程式碼，這類失敗包含：(a) 次站缺簽章能力時回 `503 relay_signing_unavailable`（`site/app/api/backend-client.ts:235-236`）；(b) 次站缺 secret（不送 header）而在主站 `require` 下被剝除身分，導致 `/api/admin/*` 401、`/api/student/*` guest（`site/lib/relay-edge-gate.ts:110`）。每筆須標記失敗原因（例如 `edge_secret_missing`／`relay_signing_unavailable`／`edge_gate_stripped`），跨站彙總時對同一使用者請求去重，避免 student／admin 或次站／主站重複計數。此計數與 §5.1 的 401／403／5xx 回滾門檻分開登記，但須一併納入失敗率證據。

#### 路由盤點與無應用日誌路徑

以候選版本的 Worker 路由表、`site/app/api/**/route.ts`、`gateApiRequest`、CORS、delegate 及 `getNormalizedAuth` 呼叫點建立清單。每列記錄環境、來源站、方法、路由模板（使用 `[id]`，不記實際 ID）、授權機制、`pathClass`、是否應產生應用日誌、成功定義、應計請求數與證據連結。無適用非 GET 路徑時，必須附路由盤點及審查證據才可標記 N/A；不能以沒流量為由略過。

目前基準 `5afbcb9` 的 relay 受保護路徑起始清單（自 `cc05e6e` 以來未新增路由；部署前仍須完整盤點核對）：

| 來源站 | 路由模板／方法 | 分類與覆蓋要求 |
| --- | --- | --- |
| Student | GET `/api/student/me`；GET、PUT `/api/student/progress` | `student`；PUT 至少 30 次（建議值，待 Owner 確認），GET 須證明登入身分成功。 |
| Admin | GET `/api/admin/auth/me`、`/api/admin/overview`、`/api/admin/books`、`/api/admin/books/[id]` | `admin`；確認有效管理員可正常存取。 |
| Admin | POST、DELETE `/api/admin/books`；POST `/api/admin/books/upload`；DELETE `/api/admin/books/[id]` | `admin`；四個路徑／方法分別至少 30 次（建議值，待 Owner 確認）；POST books 雖共用 upload handler，仍須獨立盤點。 |
| 三站其他路由 | student books／content（4 個公開 GET，不呼叫 `getNormalizedAuth`，由 edge 閘涵蓋）、`/api/internal/sync/*`、health、OPTIONS、gate 等 | 不以名稱推斷 relay 保護；核對各自授權及實際控制流程。internal sync 使用獨立驗證，不能因沒有 `relay.verify` 就宣告無請求或安全。 |

應用日誌的 `method=OTHER` 無法區分 PUT／POST／DELETE，`pathClass` 也不能區分各子路由；因此不能用 OTHER 總量代替逐路徑 30 次證據（建議值，待 Owner 確認）。以已授權的受控測試執行清單、路由模板與時間區間、平台可用的安全關聯資料核對；若無法區分或關聯，該項 `HOLD`，不得推算成功或擴充敏感日誌。

對每個固定時間區間，先從主站 invocation／路由證據求得應記錄請求數 E：觀察期僅計 primary、transitional（Strict 後監控改計 strict）、**通過 edge 閘**、已達 `getNormalizedAuth` 且非 health 的不同請求；被 edge 閘擋下者另列 `relay.probe` 類別、不計入 E 也不計入 L。再求成功解析的 `relay.verify` 筆數 L，核對 E=L 且無重複抵銷缺漏。不能從 L 反推 E；logger 的 try/catch 可能吞掉記錄失敗，HTTP 正常不保證日誌完整。平台若只提供全站總數且無法拆分，仍為 `HOLD`。

`off`、health、gate、CORS 403、次站轉送、`relay.probe` 與其他未進入 logger 的請求，應用日誌預期為 0；逐類以三站 invocation logs 核對請求、狀態與轉送結果。次站 invocation 與主站驗章是不同階段，不能相加當樣本，也不能拿零筆應用日誌當成功證據。`site` 標籤取自原始標頭，僅為枚舉標籤，來源須以次站及主站證據交叉確認。

#### 驗收交接

平台負責人提交三站設定與查詢證據；Codex 提交本文件 PR；AGY 以非作者身分檢查門檻可量測性、零樣本誤判及漏記風險（PR #61 的複驗不代替本 PR 審查）；Hermes 整合證據回報 `PASS`／`HOLD`／`FAIL`，不得自行解除 Gate。已確認的異常、洩漏或演練失敗為 `FAIL`，調查修復期間不得晉級；缺證據、未滿觀察時間、低樣本、尚未審查或尚無可執行的回滾基準為 `HOLD`；全部通過才能提出 `PASS` 建議，仍須 Owner 另行授權 Strict 切換與正式部署。

交接記錄至少包含：候選 commit／**實際 head sha**／三站部署版本、環境與視窗起訖、取樣與保留設定、實際查詢／解析步驟、分站分方法分路徑計數、E/L 核對、edge 閘模式（`A01_RELAY_EDGE_MODE`）與 `relay.probe` 計數、所有異常及調查結果、隱私檢查、基準／回滾門檻、演練結果、AGY 審查與 Hermes 結論連結。另須附「Owner 已採納的四條驗收規則」的對應證據：合併後對更新 main 的重驗、未簽章量測是否涵蓋直連主站與繞過 relay 入口、72 小時窗口的起算版本／設定／站點，以及次站缺 secret 失敗率的計數與跨站去重。空白或待補欄位不得視為通過。

## 5. 回滾

### 5.1 暫停與回滾觸發條件

| 觸發條件 | 動作 |
| --- | --- |
| 通過 edge 閘後的 `evt=relay.verify AND result=invalid` ≥1，或 `none AND identityPresent=true` 等異常身分組合 ≥1 | 立即暫停晉級，調查並保留證據；不得設未經證實的例外。被 edge 閘擋下的 `relay.probe` 不觸發本列，但須保留並計數。 |
| Strict 導致原本合法的使用者被拒 | 確認可重現後，立即依已核准的應變授權回滾。 |
| 401／403 相對 transitional 基準異常升高 | 暫停並評估回滾；分站與路徑評估，區分預期非管理員 403、CORS、gate 與 relay 拒絕。 |
| 5xx 持續升高 | 依預先登記的基準、最低樣本及連續區間門檻觸發回滾。 |
| 日誌不可用、取樣或出現無法解釋的缺口 | 停止 Strict 推進、保存已有證據；已切 Strict 時依影響必要回滾。 |

401／403 與 5xx 的數值不可事後挑選。進入 Strict 前，Owner／平台負責人須登記並由 AGY 核對：基準環境／版本／時窗、每站每路徑的請求總數 N 與錯誤數、觀測區間長度 W、每區間最低樣本 Nmin、相對基準的增幅門檻 Δ（百分點）、觸發所需連續區間數 K，以及執行者／授權。錯誤率 r=錯誤數/N；N≥Nmin 且 r−基準率≥Δ 連續 K 個區間即達已登記門檻（401／403 暫停評估，5xx 回滾）。兩類各自填入實際數值；本決議未提供這些數字，未填即 `HOLD`，不得憑空宣稱已可量測。N=0／低樣本不算零錯誤；不妨礙可重現合法使用者被拒時立即回滾。

### 5.2 回滾操作與成功判定

1. 保留異常視窗、查詢結果、三站部署版本與生效設定證據，依核准的應變授權由指定執行者處理。
2. **首選（不改程式）：主站設定 `A01_RELAY_MODE=transitional`，並重新部署。** 只修改環境變數不得宣告回滾成功。
3. 核驗平台部署完成、正確版本及生效設定；主站 health 必須回報 `relayMode=transitional`，並檢查 `relayKeys`、`adminAllowlist`、D1／R2 等健康狀態。
4. 兩站各自重跑帶平台身分的合法請求，確認學生身分與管理員授權恢復正常；依授權在 staging 驗證必要讀寫路徑。production 寫入仍須個別授權，不能藉回滾驗證擴大範圍。
5. 核對 invocation、應用日誌及 401／403／5xx 是否回到已登記的基準範圍，記錄完成時間與執行者。部署、生效設定、health、合法請求恢復皆有證據才記 `PASS`，且 `PASS` 須綁定當時實際 head sha（§4.4 Owner 驗收規則第 1 條）；缺一仍為未完成。Gate 保持 `HOLD`，修復後依 §4.4 重新驗證與起算。

- **切勿在主站 `strict` 下單獨回退次站。** `strict` 會忽略未簽章身分；若次站被單獨回退成舊版（原樣轉送 `oai-*`），這些請求會變成 guest／401，等於次站使用者全數掉線。
- **回退順序為主站 → 次站。** 若必須回退 commit：先完成主站降到 `transitional` 的部署與驗證，再依序回退次站 commit，最後才在必要時回退主站 commit。
- 回退到 `off` 的警告：`off` 會忽略 relay 標頭；若次站仍是簽章版（已刪除 `oai-*`），身分會掉成 guest。`off` 只適用於同時把次站回退到未簽章版本。
- 回退目標以 Owner 指定且經平台核驗的部署版本為準；本手冊不以 repo 合併或歷史部署紀錄推定現場版本。
- Staging 演練須走同一套設定、重新部署、health 與合法請求恢復流程；演練授權不代表 production 回滾或部署授權。

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

### 6.1 Edge secret 輪替（三階段重疊，D9=B）

以「舊 secret → 新 secret」為例，student 與 admin 分開處理：

1. **主站接受新舊兩把**：把 `A01_RELAY_EDGE_SECRET_<SITE>_PREV` 設為舊 secret，同時把現行 secret 換成新 secret；此時兩把都被接受。
2. **次站換新 secret**：把次站送出的 edge secret 換成新值並部署。次站只送「當前」值、不送 `_PREV`，故此步驟後次站即全面使用新值；舊值仍由主站的 `_PREV` 接受。
3. **觀察**：涵蓋一個部署週期，確認 `relay.probe` 未因 secret 不符而上升、`relay.verify` 的 `valid` 正常。
4. **移除舊 secret**：確認次站已全面使用新 secret 後，移除主站的 `_PREV`。

注意：順序不可顛倒；若主站尚未接受新 secret 就讓次站換新，`require` 下請求會被判為 `relay.probe` 而不進驗章。輪替期間 `require` 模式不得關閉。新舊 secret 都必須落在 32–512 字元且兩站互不相同（§1.3）；輪替期間 health `edgeSecrets` 會暫時增加（現行＋`_PREV`），可用來確認兩把都被接受，`edgeSecretsDistinct` 仍須為 `true`（#67）。

## 7. 疑難排解

對**受保護 API**（會呼叫 `getNormalizedAuth` 並檢查 `relayRejected` 的路由，例如 `/api/student/*`、`/api/admin/*`）而言，relay 驗章失敗一律只回單一 `401 {"error":"unauthorized"}`，不洩漏失敗原因。**`/api/health` 是例外**：health 不走 401 路徑，無論 `relaySeen` 是 `none`／`valid`／`invalid` 都回 `200`，並以 `relaySeen` 回報本次驗章結果（`site/app/api/health/route.ts:65-78`）。診斷請看主站 health 的 `relaySeen` 與次站設定。

| 症狀 | 可能原因 | 檢查與處置 |
| --- | --- | --- |
| 受保護 API 回 401 `{"error":"unauthorized"}`（單一對外錯誤） | relay 驗章失敗：簽章不符、站別不符、時戳超出 ±300s、nonce 重放、path／query／body 被改、金鑰未設或 < 32、兩站共用金鑰、D1 不可用 | 看主站 `relaySeen`；確認次站 `A01_RELAY_SIGNING_KEY`／`A01_RELAY_SITE` 與主站對應金鑰。relay 失敗絕不回退 `oai-*`。 |
| `GET /api/health` 回 `200` 但 `relaySeen: invalid` | health 不走 401 路徑；只表示本次 health 請求帶了 relay 標頭但驗章失敗 | 這是預期行為，不是漏回 401。要驗證受保護 API 的 401 請對 `/api/student/*`／`/api/admin/*` 測試。 |
| 次站回 `503 {"error":"relay_signing_unavailable"}` | (a) 次站缺簽章能力（`A01_RELAY_SIGNING_KEY` 未設／< 32，或 `A01_RELAY_SITE` 與 `SITE_NAME` 不符）**且**請求帶有 `oai-*` 身分；或 (b) 非 GET／HEAD 讀 body／簽章在 `try` 內拋錯（`site/app/api/backend-client.ts:238-282`） | 補齊次站變數後重新部署。注意：無簽章能力且**匿名**時**不會僅因缺少簽章能力而**回此錯誤，而是不帶任何 `oai-*`／`x-a01-relay-*` 直接轉送；但 (b) 的 body 讀取拋錯仍會回 503。 |
| 身分間歇性失效 | 兩站時鐘偏差超過 ±300s | 校正次站與主站（平台）時鐘；確認時間同步。 |
| 非 GET／HEAD 一律 401、GET 正常 | 非 GET 依賴 D1 `relay_nonces`：migration 0003 未套用、D1 binding 缺失或查詢失敗 | 套用 migration 0003（Owner 授權）；確認主站 D1 binding。D1 不可用時一律 401。 |
| 大 body 回 401 而非 413 | 有 relay 標頭時，超過 body 上限（一般 8 MiB／upload 21 MiB）在簽章驗證階段就判 `invalid` | 這是預期行為；請在上游縮小 payload。無 relay 標頭時不走此檢查，平台層可能另有更早的限制。 |
| `relayKeys` 比預期多或少 | 跨站共用任一金鑰 → 兩站皆歸零；同站現行與 `_PREV` 相同字串 → 重複計數；長度 < 32 不計入 | `relayKeys` 是綁定項數，不是相異金鑰數；修正重複或共用設定（見第 2 節）。 |
| `edgeMode` 回報 `accept` 但預期 `require` | `A01_RELAY_EDGE_MODE` 未設定／為空字串（未設定＝`accept`，不會自動升級） | 明確設定 `A01_RELAY_EDGE_MODE=require` 並重新部署；拼錯的值會落到 `require`，但不可依賴拼錯（§1.3）。 |
| 次站已送 secret 仍被視為無身分；health `edgeSecrets.<site>` 為 `0` | secret 未設定、長度不在 32–512、站別 header 不符，或跨站重用導致兩站皆失效 | 以 health `edgeSecrets`／`edgeSecretsDistinct` 與 §1.3 核對；修正後重新部署。注意 `edgeSecrets` 只給計數，不透露值或長度。 |
| health `edgeSecretsDistinct=false` | student 與 admin 的可用 secret 有任一相同（含 `_PREV` 跨站重用） | 兩站 secret 立即改為互不相同；`require` 下此狀態會讓兩站使用者全部掉線（lockout，§1.3）。 |
| admin 路由回 403 | `ADMIN_EMAILS` 未設或該 email 不在 allowlist：已驗章身分只會是 `student` | 設定主站 `ADMIN_EMAILS`；以 health `adminAllowlist=configured` 確認。完全無身分時 admin 路由回 401。 |

## 8. 已知限制與後續

- **`site/app/chatgpt-auth.ts` 仍讀未簽章標頭。** 它直接讀 `oai-authenticated-user-id`／`-email`／`-full-name`，只用於顯示（`getChatGPTUser`）；不得用於授權。授權一律走 `getNormalizedAuth` 與 `ADMIN_EMAILS`。
- **CORS allow-headers 殘留宣告待清理（PR-E）。** `site/app/api/backend-client.ts` 的 `handleCors` 仍在 `Access-Control-Allow-Headers` 宣告 `oai-authenticated-user-*` 系列；這些是瀏覽器端的舊宣告，待 PR-E 清理。
- **主站直打 health 的 `relaySeen` 多為 `none`。** 它只代表本次 health 請求，不是 PR #61 日誌的彙總；詳見 §4.1、§4.4。要觀察 `valid` 需在 staging／合成環境送出帶簽章請求。
- **Edge secret 閘（D9=B）為 `gatePrimaryApiRequest` → `gateRelayEdgeRequest`（PR #64）。** 它在主站、API 路徑、非 `/api/health` 生效；`accept`（預設）只記 `relay.probe`、其餘行為不變，`require` 才剝除 relay／oai 標頭並靜默忽略。secret 有效長度 32–512、跨站重用會讓兩站失效；`require` 下直連主站 admin／student 會 lockout，見 §1.3。PR #67 另在 health 增加唯讀 `edgeMode`／`edgeSecrets`／`edgeSecretsDistinct`（僅計數／布林），secret 輪替與 relay 金鑰輪替分開，見 §6.1。
- **設計文件不在 repo。** A-01 三站整合設計文件在 Project；本手冊以程式碼為準。
- **O-1a 未通過前不得上線。** 見第 3(a) 節。

## 9. 程式碼交叉核對

以下交叉核對的行號以 main `5afbcb9`（#64、#65、#67 已合併）為準；標為 `bbe1cfe2`／`9898c1e` 的列為歷史基準，不代表部署版本。PR #61 新增與移動的行號另列於表後，基準 `cc05e6e`；#67 只改動 `site/app/api/health/route.ts` 與 `site/lib/relay-edge-gate.ts`，故僅這兩處行號位移，其餘檔案行號沿用 `7c8f851e`。

| 項目 | 值 | 程式碼位置（基準 main `5afbcb9`） |
| --- | --- | --- |
| 次站簽章金鑰長度門檻 | ≥ 32 | `site/app/api/backend-client.ts:233` |
| 次站站別必須相符 | `A01_RELAY_SITE === SITE_NAME` | `site/app/api/backend-client.ts:233-234` |
| 次站刪除 `oai-*`／`x-a01-relay-*` | 全部刪除 | `site/app/api/backend-client.ts:213-221` |
| 匿名且簽章有效時仍簽章 | `user-id`／`user-email` 用 `-` sentinel | `site/app/api/backend-client.ts:242,262-263` |
| 匿名且無簽章能力時不帶標頭 | 不簽、不帶 `oai-*`／`x-a01-relay-*`；不會僅因缺簽章能力而 503 | `site/app/api/backend-client.ts:236,242` |
| 有身分且無簽章能力 | `503 relay_signing_unavailable` | `site/app/api/backend-client.ts:235-236` |
| 次站簽章區塊例外（含匿名） | 非 GET／HEAD 讀 body／簽章拋錯 → catch 回 503 | `site/app/api/backend-client.ts:238-282` |
| 次站 signed role 一律 `-` | `-` | `site/app/api/backend-client.ts:254,265` |
| 模式解析（舊版，#59 前，`9898c1e`） | 未設／`null`／空／`off`→`off`；`transitional`→`transitional`；其他（含純空白、`OFF`、`Transitional`）→`strict` | `site/lib/relay-verification.ts:24-29` |
| 模式解析（目前 main，含 #59） | trim＋轉小寫：純空白→`off`、`OFF`→`off`、`Transitional`→`transitional`、非字串→`strict` | `site/lib/relay-verification.ts:24-31`（`5afbcb9`） |
| 時鐘偏差 | ±300s | `site/lib/relay-verification.ts:15` |
| 一般 body 上限 | 8 MiB | `site/lib/relay-verification.ts:12` |
| upload body 上限 | 21 MiB | `site/lib/relay-verification.ts:14` |
| nonce 表 | `relay_nonces(nonce PK, expires_at)` | `site/drizzle/0003_superb_purifiers.sql:1-4`、`site/db/schema.ts:112-115` |
| nonce 僅非 GET／HEAD 使用 | GET／HEAD 不寫表 | `site/lib/relay-verification.ts:136-143` |
| 驗章失敗不回退 `oai-*` | `relayRejected` → 401 | `site/app/api/auth-helper.ts:116`；例 `site/app/api/student/me/route.ts:27-29` |
| health 不走 401 | 一律 200，以 `relaySeen` 回報 | `site/app/api/health/route.ts:40,65-78` |
| 代理成功回應標記 | `x-data-plane: primary`（含主站 401／403） | `site/app/api/backend-client.ts:299` |
| 主站不可達 | `503 backend_unavailable`（無 `x-data-plane`） | `site/app/api/backend-client.ts:306-314` |
| 次站未設 `PRIMARY_ORIGIN` | `503 backend_disabled` | `site/app/api/backend-client.ts:192-199` |
| CORS 拒絕 | `403 {"error":"cors_forbidden"}` | `site/app/api/admin/auth/me/route.ts:16-18`、`site/app/api/student/me/route.ts:17-19` |
| student guest 也是 200 | `authenticated:false, guest:true` | `site/app/api/student/me/route.ts:56-67` |
| student 驗證身分 200 | `authenticated:true, user, role, isSynthetic` | `site/app/api/student/me/route.ts:38-53` |
| admin 非管理員 403 | `authenticated:true, error:"admin permission required"` | `site/app/api/admin/auth/me/route.ts:44-49` |
| 管理員只由 allowlist 決定 | `ADMIN_EMAILS` | `site/app/api/auth-helper.ts:45-50,270-273` |
| health 欄位（#67 後） | `relayMode`／`relayKeys`／`relaySeen`／`edgeMode`／`edgeSecrets`／`edgeSecretsDistinct` | `site/app/api/health/route.ts:73-78` |
| edge 閘模式解析（未設→`accept`、無法辨識→`require`） | `undefined`／`null`→`accept`；非字串→`require`；trim＋轉小寫後 `""`／`"accept"`→`accept`，其他→`require` | `site/lib/relay-edge-gate.ts:14-19` |
| edge secret 有效長度 | 32–512 字元（含端點），超出視同未設定 | `site/lib/relay-edge-gate.ts:33-35`；次站送出判斷 `site/app/api/backend-client.ts:275` |
| edge secret 跨站重用 | 任一 student secret 等於任一 admin secret → 兩站皆空 | `site/lib/relay-edge-gate.ts:37-42` |
| health edge 欄位僅計數／布林 | `edgeSecrets` 為項數、`edgeSecretsDistinct` 為布林；不輸出值／長度／前綴／雜湊 | `site/lib/relay-edge-gate.ts:51-59`、`site/app/api/health/route.ts:76-78` |
| 兩站金鑰不得相同 | 跨站共用任一即兩站皆空 | `site/lib/relay-verification.ts:39-44` |
| `relayKeys` 為綁定項數 | 同站現行與 `_PREV` 相同會重複計數 | `site/lib/relay-verification.ts:33-37,46-49` |
| 未簽章標頭僅供顯示 | `chatgpt-auth.ts` | `site/app/chatgpt-auth.ts:11-13,21-40` |

PR #61 交叉核對（`cc05e6e`）：`site/app/api/auth-helper.ts:82-101` 為 logger（含欄位分類、字串化與 try/catch），`:103-120` 為 per-Request 快取、mode 分流、驗章後記錄及拒絕／回退決策；`site/lib/relay-verification.ts:97-148` 為驗章快取及 nonce 後結果。應用日誌測試見 `site/tests/relay-logging.test.mjs`；本地測試不代替平台管線證據。

Edge secret 閘（D9=B）由 PR #64 實作：主站在 `gateApiRequest` 之後、非 `/api/health` 的 API 路徑檢查 `x-a01-relay-edge-secret`（`gatePrimaryApiRequest` → `gateRelayEdgeRequest`，`site/lib/relay-edge-gate.ts:95-123`），模式 `A01_RELAY_EDGE_MODE=accept|require`，`/api/health` 豁免（`:121`）；`accept` 只記 `relay.probe`、保留 relay／oai 標頭照舊進驗章並移除 edge header；`require` 下缺失／錯誤 secret 記 `relay.probe`、剝除 `x-a01-relay-*`／`oai-*`、不產生 `invalid`；secret 相符但簽章錯仍為 `invalid` 401。PR #67 另在 health 增加唯讀 `edgeMode`／`edgeSecrets`／`edgeSecretsDistinct`（僅計數／布林），並匯出 `countValidEdgeSecrets` 共用同一套 32–512 與跨站重用規則（`site/lib/relay-edge-gate.ts:51-59`、`site/app/api/health/route.ts:76-78`）。相關行號以 main `5afbcb9`（#64、#65、#67 已合併）為準。

## 10. 本地驗證

- `cd site && npm test`：涵蓋 `tests/relay-canonical.test.mjs`、`tests/relay-sign-verify.test.mjs`、`tests/relay-secondary.test.mjs`、`tests/relay-verify.test.mjs`、`tests/relay-logging.test.mjs`，在同一程序內模擬兩站與 D1，不需要網路。
- PR #64 新增 edge 閘測試、#65 新增次站送出 edge secret 的測試、#67 新增 health edge 觀測與 `countValidEdgeSecrets` 測試（已合併）；`cd site && npm test` 會涵蓋 `tests/relay-edge-gate.test.mjs`、`tests/api-runtime.test.mjs`。
- 本手冊的 production 驗證只用 GET；不包含對 production 的寫入。
- 依 §4.4 Owner 驗收規則第 1 條，每次合併後須在更新後的 main 重跑 `cd site && npm test` 並重算本文件行號引用；`PASS` 須對應實際 head sha。
