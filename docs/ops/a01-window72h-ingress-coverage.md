# A-01 72h 驗收窗口：未簽章量測、入口覆蓋與合成取樣（決議整合）

本文件整合三份來源，作為 `docs/ops/relay-rollout.md` 的**補充決議記錄**（不取代該手冊，也不修改其內容以避免行號位移）：

1. **未簽章流量與全入口覆蓋量測設計** — AGY 11:09 草稿要點（Slack `#a-01-v01`），缺口與建議經 repo 程式碼核對後補齊。
2. **72h 窗口定義** — 對應專案文件 `claude/a01-window72h-draft-20261016.md`（設計文件在 Project，不在本 repo）；本文件填入 Owner 於 2026-10-16 的決議。
3. **合成取樣計畫** — Owner 13:5x／18:00 決議與 PM 2026-10-16 21:30 派工。

> **file:line 基準：main `ab69ed82bc0cbf1a48889dc611082ef7d9c5eba7`（#74／#76／#81／#82 已併）。** 所有引用皆以此 commit 為準；若程式碼後續變更，須依 `relay-rollout.md` §4.4 Owner 驗收規則第 3 條重評並重新起算窗口。
>
> **基準變更註記（2026-10-17）：** 前版基準為 `f012b82499492949a6f3958f9a823ac8d1fce30e`（#74）。`f012b824 → ab69ed82` 之間僅新增測試 `scripts/a01-coverage/core.test.mjs`（#81）與 `scripts/a01-synthetic/core.test.mjs`（#82），**未更動任何 `site/**`、`docs/ops/**` 或 production 腳本**，故本文件所有 file:line 引用不變。
>
> **基準變更註記（2026-10-16）：** 前版基準為 `b9ee98e33a1f3353d0d3c6f0c457fcd28fe31637`（#76）。`b9ee98e3 → f012b824` 之間僅新增 `scripts/a01-synthetic/` 與 `docs/evidence/`（#74），未更動任何 `site/**` 或 `docs/ops/**` 既有檔案，故本文件所有 `site/**` 行號不變；受影響者為原標為「open PR #74／`b9ee98e3` 尚未包含」之引用，已更新為併入狀態並補行號（見 §3.3、§3.4、附錄 A）。

> **狀態標記：** `【決議】`＝Owner 已決定；`【提案】`＝尚未經 Owner 確認，不得作為 Gate 通過或回滾依據；`【現況】`＝程式碼／既有文件已存在之事實。

---

## 0. 來源與限制

- AGY 11:09 草稿與 `claude/a01-window72h-draft-20261016.md` 的**原文不在本 repo**（設計文件在 Project；草稿在 Slack `#a-01-v01`）。本文件整合 PM 派工所轉述之要點，並以 repo 內可核對的程式碼與 `docs/ops/relay-rollout.md` 為 file:line 依據。
- 若原始草稿與本文件有出入，**以程式碼與 Owner 決議為準**，並回到原草稿補正。
- 本文件不含任何 secret 值、帳密、PII；僅描述變數名稱、欄位與判定邏輯。

---

## 1. 未簽章流量與全入口覆蓋量測設計

### 1.1 目的

Strict Release Gate 需要證明「未簽章流量」已可被完整量測，且**全入口**（不只是次站代理路徑）都在量測範圍內。若只量 `relay.verify`，會漏掉不產生該日誌的入口，低估未簽章流量。此為 `relay-rollout.md` §4.4 Owner 驗收規則第 2 條（未簽章量測須涵蓋直連主站與繞過 relay 的入口）的落地設計。

### 1.2 現況與缺口【現況】

`relay.verify` 只在主站 `transitional`／`strict` 且請求進入 `getNormalizedAuth` 時產生：

- 產生日誌：`site/app/api/auth-helper.ts:103-115`（`getNormalizedAuth`）→ `:82-101`（`logRelayVerification`）。
- 僅 primary：`:84`（`SITE_ROLE !== "primary"` 直接 return）。
- 只記 student／admin／other：`:86-88`（`pathClass`）；health 直接 return（`:89`），故 health 不寫 `relay.verify`。
- `method` 已於 #70 拆為實際動詞（GET／HEAD／PUT／POST／DELETE／PATCH，其餘 `OTHER`）：`:92`。
- 日誌欄位：`evt,result,site,mode,identityPresent,method,pathClass,synthetic`：`:93-97`。

**沒有 `relay.verify` 的入口（缺口）：**

| 入口 | 位置（`f012b824`） | 現行控制 |
| --- | --- | --- |
| student 公開 books／content（4 個 GET） | `site/app/api/student/books/route.ts:15`、`site/app/api/student/books/[id]/route.ts:19`、`site/app/api/student/books/content/route.ts:16`、`site/app/api/student/books/[id]/content/route.ts:20` | 不呼叫 `getNormalizedAuth`，僅由 edge 閘涵蓋 |
| internal sync（POST／GET） | `site/app/api/internal/sync/_shared.ts:37`（`authorizeSyncRequest`） | 獨立 `x-sync-timestamp`／`x-sync-nonce`／`x-sync-signature` HMAC，不走 relay |
| health | `site/app/api/health/route.ts:69`（`relaySeen`）、`site/app/api/auth-helper.ts:89` | edge 閘豁免、不寫 `relay.verify` |
| CORS／OPTIONS preflight | `site/app/api/student/progress/route.ts:10-13`、`site/app/api/backend-client.ts:326`（`handleCors`） | preflight 於驗身分前回應 204／403，不寫 `relay.verify` |
| edge 閘剝除請求 | `site/lib/relay-edge-gate.ts:74-83`（`relay.probe`）、`:86-101` | 記 `evt=relay.probe`，**不**計入 `relay.verify` 的 `invalid` 零容忍 |

**其他量測限制【現況】：**

- `pathClass` 只分 `student`／`admin`／`other`（`:86-88`），無法區分各子路由；逐路徑 30 次須另以路由模板核對。
- #70 之前的日誌 `method` 仍為 `OTHER`，統計時須與新日誌分開處理。
- edge 閘在 `require` 下把缺少／錯誤 secret 的請求剝除並記 `relay.probe`（`site/lib/relay-edge-gate.ts:101`），不進 relay 驗章。

### 1.3 建議量測設計【提案，未經 Owner 確認】

以下四項為 AGY 草稿要點，**均屬提案**；在 Owner 確認前不得作為 Gate 通過或回滾依據：

1. **ingress 100% 採集【提案】**：在平台 invocation 層對三站**全部入口**（含 books／sync／health／CORS／static）做 100% 採集，取得 ingress 總量；不取樣、不依賴應用日誌是否寫 `relay.verify`。應用日誌 100% 為既有 Gate 要求（`relay-rollout.md` §4.4），本項補的是「沒有應用日誌的入口」。
2. **nonce 去重【提案】**：跨站彙總時以 nonce（非 GET／HEAD）與請求識別去重，避免 student／admin 或次站／主站重複計數；與 Owner 驗收規則第 4 條的跨站去重一致。relay nonce 表為 `site/drizzle/0003_superb_purifiers.sql`（`relay_nonces`）；本項僅描述量測去重，不改程式。
3. **失敗原因碼【提案】**：每筆失敗標記原因，建議分類沿用 Owner 驗收規則第 4 條：`relay_edge_secret_unavailable`／`relay_signing_unavailable`／`edge_secret_missing`／`edge_gate_stripped`。現況程式已存在前兩者的錯誤字串（`site/app/api/backend-client.ts:236`、`:243-244`），但**彙總用的原因碼分類仍為提案**。
4. **覆蓋等式【提案】**：
   ```
   ingress 總量 = relay.verify + relay.probe(剝除) + health + books + sync + cors + static
   差值須為 0
   ```
   等式已由已併的 `scripts/a01-coverage/`（#76）以可設定輸入實作（`scripts/a01-coverage/core.mjs:177-192`；`README.md:14`），輸出標明「提案，未經 Owner 確認」。缺任一分量即 `HOLD`，不推估。
   - **分量互斥性與單一分母【提案，未經 Owner 確認】**：上述分量**並非天然互斥**——(a) edge 閘剝除的請求會**先記 `relay.probe`**，其後若仍到達應用層，可能再產生一筆 `relay.verify result=none`（同一請求被兩桶各記一次）；(b) 次站 delegate 到主站為**次站／主站雙重 invocation**。故即使「完整採集」，未去重仍可能算出非 0 差值。修正：須先定義**單一 ingress 分母**（以平台 invocation 為準、涵蓋三站），並規定**每筆 invocation 依固定判定順序歸入唯一桶**——先判 edge 剝除（→`probe`）→ 再判 health／books／sync／cors／static（→對應桶）→ 餘者為 `verify`；同一請求的後續 hop／重複 invocation 不再重複計入（與本節第 2 項 nonce 去重一致）。此分母定義與歸屬規則仍為**【提案】**，不得作為 Gate 依據。

### 1.4 與 Owner 已決規則的關係

- Owner 驗收規則第 2 條（未簽章量測涵蓋直連主站與繞過 relay 入口）為**【決議】**；§1.3 為其量測實作**【提案】**。
- 次站缺 secret 的使用者失敗（含 `503`）計入失敗率、標原因、跨站去重為**【決議】**（Owner 驗收規則第 4 條）。

---

## 2. 72h 窗口定義（Owner 決議填入）

本節把 `relay-rollout.md` §4.4／§5 中「待 Owner 確認」的欄位填入 2026-10-16 決議。**`relay-rollout.md` 本身不修改**；本節為決議記錄。

### 2.1 窗口性質

- **【決議】transitional 窗口**：72 小時觀察窗口在主站 `A01_RELAY_MODE=transitional` 下進行。
- **【決議】strict 另開**：Strict 切換為另一個獨立窗口／決策，不與 transitional 觀察窗口混算。
- **【決議】窗口長度下限 24 小時（Owner 2026-10-17）**：僅當流量足以在 24 小時內覆蓋所有主要路徑與站別時才可接受；低流量時 24 小時可能完全沒有樣本（見 §5.2 盲區）。
- 起算前置不變【現況】：須次站已送 edge secret 且主站 `A01_RELAY_EDGE_MODE=require` 已部署並驗證生效（`relay-rollout.md` §4.4；`site/lib/relay-edge-gate.ts:105-112`）。

### 2.2 樣本門檻（採用）

- **【決議】300／100／30 採用**：
  - Student `result=valid` ≥ 300、Admin `result=valid` ≥ 100（**僅自然樣本**；合成不計入，見 §3）。
  - 每個適用非 GET 路徑 × 動詞 ≥ 30 成功驗證；GET 納入（Owner 18:00 決議）。
  - 分列實際 HTTP 動詞（`site/app/api/auth-helper.ts:92`）與路由模板；`pathClass` 不足以區分，須以路由模板逐項核對。
- 零容忍不變【決議】：`result=invalid` ≥ 1，或 `result=none AND identityPresent=true` ≥ 1，即立即暫停晉級並回滾（見 §2.7）。edge 閘擋下的 `relay.probe` 不觸發本項。

### 2.3 起算、設定與重評

- **【決議】** 每個窗口記錄起算版本（commit sha）、三站生效設定（`A01_RELAY_MODE`、`A01_RELAY_EDGE_MODE`、金鑰／secret 綁定版本）與站點範圍（Owner 驗收規則第 3 條）。
- **【決議】** 任何影響驗章或量測的變更（程式碼、執行期變數、路由、日誌程式或採集設定）後，該窗口失效，須重新驗證管線並重新起算；不得拼接前後區間。

### 2.4 日誌保留與脫敏

- **【決議】接受平台上限**：Workers Logs 保留期 Paid 方案 7 天時，72 小時觀察窗涵蓋；**Free 方案 3 天＝72 小時，不足以涵蓋，不得開窗**。實際方案與保留期以 Owner production snapshot C 節實證為準。日後若確需 14 天，須改走 Logpush／OpenTelemetry 匯出（新設定與費用），另由 Owner 決議。
- **【決議】IP 遮罩、ID 雜湊**：對外證據只保留遮罩 IP（IPv4 /16、IPv6 /48）與雜湊 ID，無原始 IP／完整路徑／query 實體 ID。
- 應用日誌（`relay.verify`／`relay.probe`）不得含金鑰、簽章、nonce、email、user-id、Authorization、cookie、IP、含 ID 的完整路徑與查詢字串（`relay-rollout.md` §4.4 敏感資訊外洩項）。

### 2.5 日誌匯出權限

- **【決議】日誌匯出權限為 AGY + Owner**；其他代理與 PM 不讀取或轉述任何帳密／secret；平台原生 invocation metadata 另受平台 RBAC 控管，對外匯出前須先脫敏。

### 2.6 ingress 等價判定

- **【決議】ingress 等價以「設定比對清單」判定，並由非作者驗證者判定**。
- 判定方式：以候選版本的 Worker 路由表、`site/app/api/**/route.ts`、`gatePrimaryApiRequest`（`site/worker/index.ts:89-91`；`site/lib/relay-edge-gate.ts:105-112`）、CORS（`site/app/api/backend-client.ts:326`）及 `getNormalizedAuth` 呼叫點建立設定比對清單，逐列核對；不得以名稱推斷保護狀態。
- **【決議】證據＝設定比對清單「逐列全等」（Owner 2026-10-17）**：清單每一列（Worker 路由表、各 `route.ts`、`gatePrimaryApiRequest`、CORS、`getNormalizedAuth` 呼叫點）的候選值須與基準**完全相等**；**任一列不等即判不等價**，不得以「等價／近似」或名稱推斷替代。
- 非作者驗證者：合成相關 PR 與結果的驗證不得由 AGY（AGY 為合成執行者）；作者不驗自己。

### 2.7 回滾門檻與執行（決議）

- **【決議】回滾參數**：觀測區間長度 `W = 30min`、每區間最低樣本 `Nmin = 100`、相對基準增幅門檻 `Δauth = +1pp`（401／403）、`Δ5xx = +0.5pp`、觸發所需連續區間數 `K = 3`。
- **【決議】零容忍立即回滾**：`result=invalid` ≥ 1 或 `none AND identityPresent=true` ≥ 1，或可重現的合法使用者被拒，**不受 W／Nmin／Δ／K 限制，立即回滾**。
- **【決議】回滾執行人為 AGY、Owner 事後確認**（修正前稿「執行人預設 Owner、AGY 監看」）。
- 回滾首選（不改程式）：主站 `A01_RELAY_EDGE_MODE` 改回 `accept`，並**重新起算 72h 窗口**；以合法請求恢復成功為判定（`relay-rollout.md` §5.2）。窗口內 `A01_RELAY_MODE` 本即為 `transitional`，回滾**不需**改 `A01_RELAY_MODE`、亦**不需**重新部署或切換模式。
- 5xx 基準須納入次站 `503 relay_signing_unavailable`（`site/app/api/backend-client.ts:236`）與 `require` 下的 `503 relay_edge_secret_unavailable`（`site/app/api/backend-client.ts:243-244`），標原因、跨站去重（Owner 驗收規則第 4 條）。

---

## 3. 合成取樣計畫

### 3.1 角色分離【決議】

- **執行：AGY**（建立測試帳號、管理執行期變數、注入流量、停止與清理）。
- **驗證：非 AGY**（合成標記 PR 與合成流量結果的驗證改由非 AGY 擔任；AGY 不得驗自己的執行）。
- **【決議】secrets／部署維護者：AGY（Owner 2026-10-17）**：edge secret 與其他執行期 secret 之維護、以及部署（含 `A01_RELAY_EDGE_MODE=require`）由 AGY 執行；回滾亦由 AGY 執行、Owner 事後確認（見 §2.7）。
- 邊界：**僅 staging**；不碰 production；不讀取或轉述任何帳密／secret。

### 3.2 樣本計數【決議】

- **合成只補 ≥30、不計入 300／100**：合成樣本只填補每個適用非 GET 路徑 × 動詞的 `>=30` 下限；Student `>=300` / Admin `>=100` 僅計自然樣本。
- **【決議】(a) 獨立檢查（Owner 2026-10-17 08:30）**：原兩案衝突（staging 合成樣本歸屬 vs runbook「staging 樣本不得計入 production」）已由 Owner 裁定採 **(a)**：
  - `staging` 自身達 `>=30` 即通過該**獨立檢查項**；**production 非 GET 路徑 × 動詞 `>=30` 仍需自然樣本**（合成**不補** production）。
  - 未採 (b)：不以 staging 合成樣本補足 production 的 `>=30` 下限（原案 (b)「明確接受補量」**已否決**，保留供追溯）。
  - 本項為**獨立檢查**：staging 合成 `>=30` 與 production 自然樣本 `>=30` 分列判定，不得互相替代。
- **含 GET**（Owner 18:00 決議）。
- 合成樣本與自然樣本**分列**，不得混算。
- 合成標記僅能由**已驗章身分**（`parsed.userId`／`parsed.email`）完全等於非 secret 白名單 `A01_SYNTHETIC_ACCOUNTS` 時為 `true`（`site/app/api/auth-helper.ts:306-351`，特別是 `:343-351`）；請求標頭或 body 無法設定；未設定或空白一律 `false`（fail-closed）。health 僅以布林 `syntheticAllowlist` 回報是否已設定（`site/app/api/health/route.ts:103`）。

### 3.3 產出與脫敏【決議】

- 僅寫出彙總與 manifest 至 `docs/evidence/`：IP 遮罩（IPv4 `/16`、IPv6 `/48`）、ID 雜湊、無原始請求內容、無 secret。
  - 註：`docs/evidence/` 目錄契約（`README.md`／`.gitignore`）已於 main `f012b824`（#74）併入（`docs/evidence/README.md:1-18`）；本文件不修改該目錄。
- 參考實作：`scripts/a01-synthetic/` 已於 main `f012b824`（#74）併入（`scripts/a01-synthetic/index.mjs:19-23`（停止與脫敏輸出）、`:145-152`（清理計畫）；`scripts/a01-synthetic/core.mjs:78-117`（staging 守門）、`:142-176`（脫敏／遮罩／雜湊）；`scripts/a01-synthetic/targets.mjs:13-27`（路徑×動詞矩陣））。若其行為與本節 Owner 決議衝突，以本節 Owner 決議為準。

### 3.4 窗口後清理【決議】

- 視窗結束後**清除測試帳號與白名單**（移除 `A01_SYNTHETIC_ACCOUNTS` 測試身分項目）。
- manifest 記錄清理步驟：刪除測試資料、停用測試帳號、移除白名單（實作見 `scripts/a01-synthetic/index.mjs:145-152`（清理計畫）與 `:216-221`（`--cleanup` 執行）；`f012b824`／#74 已併）。

### 3.5 已排除選項

- **【決議】選項 C 已排除**（不採用「驗章前對帶 `x-a01-relay-*` 但格式不全者靜默 401 且不記 invalid」之作法）。

---

## 4. 與 `relay-rollout.md` 的關係與未決事項

- 本文件**不修改** `docs/ops/relay-rollout.md`，以避免行號位移；兩者衝突時，Owner 決議優先，並回頭修訂 `relay-rollout.md`（另開 PR）。
- 仍為 `HOLD`／未完成之項（不因本文件而解除）：三站平台日誌可用性、O-1a 前置、D1 migration `0003` 套用、平台管線預檢、staging 回滾演練、Strict 切換授權。詳見 `relay-rollout.md` §3、§4.2、§4.4。
- §1.3 四項量測設計與 `scripts/a01-coverage/` 的覆蓋等式仍為**【提案】**，須 Owner 確認後才可作為 Gate 依據。
- **已決（Owner 2026-10-17 08:30）**：staging 合成樣本是否計入 production 的 `>=30` 下限（§3.2）採 **(a) 獨立檢查**——`staging` 自身達 `>=30` 即通過該獨立項；**production 非 GET 路徑 × 動詞 `>=30` 仍需自然樣本**（合成不補 production）。

---

## 5. 補充：合成補樣清單、盲區、停止條件與覆蓋分量（併入 WorkBuddy #79）

> 本節由 PR #80 追加 commit 併入（內容原見 WorkBuddy #79）。標**【提案，未經 Owner 確認】**者不得作為 Gate 通過或回滾依據。

### 5.1 合成補樣清單（非 GET 路徑 × 動詞，各 ≥30 `valid`）

門檻「每非 GET 路徑 × 動詞 ≥ 30」為**【決議】**（見 §2.2）。下列為依 `relay-rollout.md` §4.3／§4.4 路由盤點所得的**受保護且低頻非 GET 路由【現況】**：

| 站別 | 路由模板 | 方法 | `pathClass` | 目標（合成） |
| --- | --- | --- | --- | --- |
| Student | `/api/student/progress` | PUT | student | ≥ 30 |
| Admin | `/api/admin/books` | POST | admin | ≥ 30 |
| Admin | `/api/admin/books` | DELETE | admin | ≥ 30 |
| Admin | `/api/admin/books/[id]` | DELETE | admin | ≥ 30 |
| Admin | `/api/admin/books/upload` | POST | admin | ≥ 30 |

- GET 路徑以自然流量為主；**Owner 已決：合成含 GET**（依指示納入），其餘 GET 預設不補。
- **注意**：`relay.verify` 的 `pathClass` 只分 `student`／`admin`／`other`，**無法區分同方法的不同子路由**（例：`POST /api/admin/books` 與 `POST /api/admin/books/upload` 同為 `method=POST`、`pathClass=admin`）。補樣清單與計數須**輔以主站 invocation／路由證據（含 URL 模板）**交叉比對；無法區分即該項 `HOLD`（與 `relay-rollout.md` 路由盤點一致）。
- `OPTIONS`（CORS 預檢）不呼叫 `getNormalizedAuth`、不產生 `relay.verify`；`/api/internal/sync/*` 走獨立驗證；health 不記錄——皆不在本清單。

### 5.2 盲區清單（日誌看不到的）【現況】

| # | 盲區 | 等級 | 說明 |
| --- | --- | --- | --- |
| B1 | 平台日誌可用性未確認 | **HIGH** | 若平台不暴露日誌，整個門檻無法量測；**切 strict 前的阻塞項** |
| B2 | `off` 模式 0 行 | HIGH | `off` 時 auth-helper 提前 return，完全不記錄；窗內誤設 `off` 會無聲無資料 |
| B3 | health 0 行 | MED | health 於程式內即排除（`pathClass=health` 提前 return） |
| B4 | 次站 delegate 0 行 | MED | `none & identityPresent` 只在主站可見 |
| B5 | 快取／CDN 繞過 | MED | 未到 Worker 的請求不記錄 |
| B6 | 抽樣 | MED | 破壞缺席證明 |
| B7 | 保留期上限 | LOW | 觀察窗須**小於**保留期，否則資料淘汰。Owner 2026-10-18：接受平台上限——Paid 7 天時 72h 涵蓋；**Free 3 天＝72h 不足，不得開窗**；實際方案以 snapshot C 節為準；14 天須 Logpush／OTel |
| B8 | 主站直連流量 | LOW | 會被記為 `none & identityPresent=true`（可抓），但需流量確實到主站 |
| B9 | 時鐘偏差 | LOW | ±300s 外的合法請求會被記為 `invalid`，可能誤觸回滾 |

### 5.3 合成執行：節奏與停止條件【提案，未經 Owner 確認】

- **節奏【提案】**：逐「路由模板 × 方法」執行，每項目標 ≥ 30 `valid`；分時段（例：每小時一批）避免瞬間灌量；每批前後留空窗，便於以時間窗切分合成樣本；全程在 staging。
- **停止條件【提案】**（任一成立即暫停並回報）：
  1. 出現非預期狀態碼（非 2xx／非預期 4xx）或 `relay.verify result=invalid` 上升。
  2. `synthetic=true` 出現在**非**白名單帳號，或白名單帳號出現 `synthetic=false`（標記異常）。
  3. 觀察到影響真實使用者（真實流量錯誤率上升）。
  4. 觸及任何 production 資源（立即停止）。
  5. 授權窗到期或 Owner／維運指示停止。
- **清理【決議】**（對應 §3.4「窗口後清除測試帳號與白名單」）：刪除本次建立的合成資料列（以 run manifest 記錄的 ID 為準，先建後刪）、刪除 staging R2 合成物件、移除／停用測試帳號與 `A01_SYNTHETIC_ACCOUNTS`；保留脫敏彙總與 manifest。

### 5.4 覆蓋等式「分量 ⇄ 入口」對照表【提案，未經 Owner 確認】

對每個固定時間區間，先求應記錄請求數 E、再求成功解析的 `relay.verify` 筆數 L，核對 **E=L**（`relay-rollout.md` §4.4）。覆蓋等式（**提案，未經 Owner 確認**；實作見 `scripts/a01-coverage/core.mjs:177-192`）：

```
ingress 總量 = verify + probe 剝除 + health + books + sync + cors + static
差值須為 0
```

| 分量 | 對應入口 | 是否產生 `relay.verify` |
| --- | --- | --- |
| `verify` | 主站 `getNormalizedAuth`、通過 edge 閘、非 health 的受保護請求（即 L） | 是 |
| `probe` 剝除 | `require` 下缺／錯 edge secret、被剝除的請求 | 否（記 `relay.probe`） |
| `health` | `/api/health` | 否 |
| `books`／`content` | 次站公開 GET（不呼叫 `getNormalizedAuth`） | 否 |
| `sync` | `/api/internal/sync/*`（獨立驗證） | 否 |
| `cors` | `OPTIONS` 預檢 | 否 |
| `static` | 靜態資源 | 否 |

缺任一分量即 `HOLD`，不推估。

**分量互斥性與單一分母【提案，未經 Owner 確認】**：上表分量**非天然互斥**——edge 剝除的請求可能先記 `relay.probe`，其後於應用層再產生 `relay.verify result=none`；次站 delegate 到主站為雙重 invocation。故須以**單一 ingress 分母**（平台 invocation、涵蓋三站）並規定**每筆 invocation 依固定判定順序歸入唯一桶**（先 `probe` 剝除 → 再 `health`／`books`／`sync`／`cors`／`static` → 餘者 `verify`），同一請求的後續 hop 不重複計入。

---

## 附錄 A：`f012b824` 引用清單（file:line）

| 主題 | 位置 |
| --- | --- |
| `relay.verify` 產生與欄位 | `site/app/api/auth-helper.ts:82-101`（`:84` primary、`:86-89` pathClass／health、`:92` method、`:93-97` 欄位） |
| `getNormalizedAuth` | `site/app/api/auth-helper.ts:103-115` |
| 合成標記（非 secret、不可偽造） | `site/app/api/auth-helper.ts:306-351`（`:343-351`） |
| relay 模式解析（未設＝off、未識別＝strict） | `site/lib/relay-verification.ts:24-31` |
| 時鐘偏差 ±300s | `site/lib/relay-verification.ts:15` |
| health 欄位 | `site/app/api/health/route.ts:69`（`relaySeen`）、`:88-94`（`relayMode`／`edgeMode`／`edgeSecrets`）、`:100-103`（`adminAllowlist`／`syntheticAllowlist`） |
| edge 閘剝除與 `relay.probe` | `site/lib/relay-edge-gate.ts:60-67`、`:74-83`、`:86-101`、`:105-112` |
| edge 模式與 secret 長度 32–512 | `site/lib/relay-edge-config.ts:4-9`、`:11-13` |
| 次站 503 原因碼 | `site/app/api/backend-client.ts:236`、`:243-244` |
| CORS／allow-headers 殘留 | `site/app/api/backend-client.ts:326`、`:363-364` |
| Worker 入口閘 | `site/worker/index.ts:89-91` |
| internal sync 獨立驗證 | `site/app/api/internal/sync/_shared.ts:37` |
| student 公開 books／content | `site/app/api/student/books/route.ts:15`、`site/app/api/student/books/[id]/route.ts:19`、`site/app/api/student/books/content/route.ts:16`、`site/app/api/student/books/[id]/content/route.ts:20` |
| CORS preflight | `site/app/api/student/progress/route.ts:10-13` |
| relay nonce 表 | `site/drizzle/0003_superb_purifiers.sql`（`relay_nonces`） |
| 覆蓋等式實作（提案） | `scripts/a01-coverage/core.mjs:177-192`、`scripts/a01-coverage/README.md:14` |
| 合成驅動 | `scripts/a01-synthetic/`（`f012b824`／#74 併入：`index.mjs:19-23`、`:145-152`、`:216-221`；`core.mjs:78-117`、`:142-176`；`targets.mjs:13-27`） |
| 脫敏證據目錄 | `docs/evidence/`（`README.md`／`.gitignore`；`f012b824`／#74 併入） |
| 既有 72h Gate 與回滾 | `docs/ops/relay-rollout.md` §4.4、§5 |

## 附錄 B：決議 vs 提案對照

| 項目 | 狀態 |
| --- | --- |
| transitional 窗口、strict 另開 | 【決議】 |
| 300／100／30 採用（300／100 僅自然樣本） | 【決議】 |
| 合成只補 ≥30、不計入 300／100、含 GET、僅 staging | 【決議】 |
| 接受平台上限（Paid 7 天→72h 涵蓋；Free 3 天＝72h 不足，不得開窗；實際以 snapshot C 節為準；14 天須 Logpush／OTel）；IP 遮罩、ID 雜湊 | 【決議】（Owner 2026-10-18 更正） |
| 日誌匯出權限 AGY + Owner | 【決議】 |
| ingress 等價以設定比對清單**逐列全等**、由非作者驗證者判定 | 【決議】（Owner 2026-10-17） |
| 回滾 W=30min／Nmin=100／Δauth=+1pp／Δ5xx=+0.5pp／K=3；零容忍立即回滾；執行人 AGY、Owner 事後確認；回滾＝`A01_RELAY_EDGE_MODE` 改回 `accept` 並重新起算 72h | 【決議】 |
| secrets／部署維護者 = AGY（部署含 `A01_RELAY_EDGE_MODE=require`；回滾亦 AGY 執行、Owner 事後確認） | 【決議】（Owner 2026-10-17） |
| 窗口後清除測試帳號與白名單；選項 C 排除 | 【決議】 |
| ingress 100% 採集 | 【提案】 |
| nonce 去重 | 【提案】 |
| 失敗原因碼彙總分類 | 【提案】 |
| 覆蓋等式 `ingress = verify + probe + health + books + sync + cors + static`（含單一分母與唯一桶歸屬規則） | 【提案】 |
| 窗口長度下限 24 小時（§2.1） | 【決議】（Owner 2026-10-17） |
| 合成補樣清單（5 個非 GET 路徑 × 動詞；§5.1） | 【現況】（路由盤點；門檻 ≥30 為【決議】） |
| 盲區清單 B1–B9（§5.2） | 【現況】 |
| 合成節奏與停止條件 5 條（§5.3） | 【提案】 |
| 覆蓋等式「分量 ⇄ 入口」對照表（§5.4） | 【提案】 |
| staging 合成樣本是否計入 production `>=30`（§3.2） | 【決議】(a) 獨立檢查：staging 自身達 ≥30 即通過該獨立項；production 非 GET ≥30 仍需自然樣本（Owner 2026-10-17） |
