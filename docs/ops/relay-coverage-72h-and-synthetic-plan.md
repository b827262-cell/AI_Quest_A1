# A-01 relay 量測設計、72h 觀察窗與合成取樣計畫

> **文件性質**：整合性 ops 文件（**僅文件、不含程式**）。
> **基準**：main `b9ee98e33a1f3353d0d3c6f0c457fcd28fe31637`；本文件所有 file:line 皆以此為準。
> **邊界**：不合併、不部署、不讀 secret、不碰 migration `0003`、不 force-push。
> **定位**：本文件**不取代** `docs/ops/relay-rollout.md`；後者 §4.4 為量測與 Strict Release Gate 的權威落地條文。本文件在其上把「未簽章流量與全入口覆蓋量測設計」、「72h 觀察窗定義」、「合成取樣計畫」三主題整合成單一入口，並把 Owner 2026-10-16 決議套用進去。

---

## 0. 來源與整合說明

本文件整合三份材料：

| # | 主題 | 來源 | 本文件落地位置 |
| --- | --- | --- | --- |
| ① | 未簽章流量與全入口覆蓋量測設計 | AGY 2026-10-16 11:09 草稿（Slack `#a-01-v01`） | §1；要點亦已併入 `docs/ops/relay-rollout.md` §4.4、§9 |
| ② | 72h 觀察窗定義 | 專案文件 `claude/a01-window72h-draft-20261016.md`（在 Project、不在本 repo）＋ Owner 2026-10-16 決議 | §2 |
| ③ | 合成取樣計畫 | 工作區《A-01 合成流量補樣計畫（定稿）》 | §3 |

**讀取限制聲明（重要）**：來源①（Slack 草稿）與②（`claude/a01-window72h-draft-20261016.md`）**不在本 repo、本次無法直接讀取**。本文件**不逐字重現**該二來源，而是以 repo 內 `relay-rollout.md` §4.4／§9 的既有條文與 Owner 已下達決議重述其可落地要點。若需與該二來源逐字對齊，請 PM／Owner 提供原始檔後再行校對。

**標示慣例**：文中凡標「**提案，未經 Owner 確認**」者即尚未取得 Owner 確認；標「**Owner 已決**」者為 2026-10-16 決議已採納項（見 §2.5）。

---

## 1. 未簽章流量與全入口覆蓋量測設計

### 1.1 目標

- 對「未帶 `x-a01-relay-*` 的**未簽章流量**」與「**所有入口**」建立可量測、可核對的覆蓋設計，供 Strict Release Gate 判定。
- 原則（`docs/ops/relay-rollout.md` §4.4 Owner 驗收規則第 2 條）：**不得只量次站來源**；量測範圍須同時涵蓋 (a) 直連主站、不經次站代理的請求，與 (b) 任何繞過 relay 的入口（直打主站 API、非次站代理路徑、edge 閘豁免的 health 等）。只量次站會低估未簽章流量；量測範圍須在候選版本的路由盤點中明列，無法區分即 `HOLD`。

### 1.2 量測欄位（`relay.verify`，@ `b9ee98e3`）

| 欄位 | 值域／語意 | 位置 |
| --- | --- | --- |
| `evt` | 固定 `"relay.verify"` | `site/app/api/auth-helper.ts:94` |
| `result` | `valid`／`invalid`／`none` | `site/app/api/auth-helper.ts:94` |
| `site` | `student`／`admin`／`unknown`（取自 `x-a01-relay-site`） | `site/app/api/auth-helper.ts:90-91` |
| `mode` | `transitional`／`strict` | `site/app/api/auth-helper.ts:82,94` |
| `identityPresent` | 布林；`oai-authenticated-user-id` 或 `-email` 標頭存在 | `site/app/api/auth-helper.ts:95` |
| `method` | **實際 HTTP 動詞** GET／HEAD／PUT／POST／DELETE／PATCH，其餘 `OTHER` | `site/app/api/auth-helper.ts:92` |
| `pathClass` | `student`／`admin`／`other`（`health` 提前 return，不記錄） | `site/app/api/auth-helper.ts:86-89` |
| `synthetic` | 布林，預設 `false`；詳見 §3.1 | `site/app/api/auth-helper.ts:96` |

產生條件與限制：
- 僅 `SITE_ROLE === "primary"` 才記錄；同一 `Request` 最多一行；`logger` 以 try/catch 包住，**記錄失敗不影響驗章或授權**。`site/app/api/auth-helper.ts:84,98-100`
- edge 閘在 `require` 下剝除的請求改記 `relay.probe`（不含敏感資料），不進 `relay.verify`。`site/lib/relay-edge-gate.ts:77`
- `method` 由原「GET／HEAD／OTHER」三分改為記錄實際動詞（PR #70）；**在此之前已記錄的日誌仍為 `OTHER`，統計時須分開處理**。`docs/ops/relay-rollout.md:342`

### 1.3 全入口分類與覆蓋等式（**提案，未經 Owner 確認**）

對每個固定時間區間，先由主站 invocation／路由證據求「應記錄請求數 E」，再求成功解析的 `relay.verify` 筆數 L，核對 **E=L** 且無重複抵銷缺漏（`docs/ops/relay-rollout.md:346`）。覆蓋等式（**提案，未經 Owner 確認**；實作於 `scripts/a01-coverage/core.mjs:13-15,21-26`，輸出標示 `提案，未經 Owner 確認`）：

```
ingress 總量 = verify + probe 剝除 + health + books + sync + cors + static
差值須為 0
```

| 分量 | 對應入口 | 是否產生 `relay.verify` |
| --- | --- | --- |
| `verify` | 主站 `getNormalizedAuth`、通過 edge 閘、非 health 的受保護請求（即 L） | 是 |
| `probe` 剝除 | `require` 下缺／錯 edge secret、被剝除的請求 | 否（記 `relay.probe`） |
| `health` | `/api/health` | 否（程式內提前 return） |
| `books`／`content` | 次站公開 GET（不呼叫 `getNormalizedAuth`） | 否 |
| `sync` | `/api/internal/sync/*`（獨立驗證） | 否 |
| `cors` | `OPTIONS` 預檢 | 否 |
| `static` | 靜態資源 | 否 |

> 各分量由 `--ingress` 可設定輸入提供；未提供即 `HOLD`，不推估。`scripts/a01-coverage/README.md:14,40-44`

### 1.4 無 `relay.verify` 的入口（缺口盤點）

依 `docs/ops/relay-rollout.md:329-348`（路由盤點與無應用日誌路徑）：books／content、`/api/internal/sync/*`、health、`OPTIONS`(CORS)、gate／static 皆**不產生 `relay.verify`**。**不得**因「沒有 `relay.verify`」即宣告無請求或安全；須逐類以三站 invocation logs 核對請求、狀態與轉送結果。`off`、health、gate、CORS 403、次站轉送、`relay.probe` 與其他未進 logger 的請求，應用日誌**預期為 0**。

### 1.5 建議與決策狀態

| 建議 | 狀態 |
| --- | --- |
| ingress／應用及平台採集 **100%、不取樣** | **Owner 已決**（連續 72h、100% 不取樣） |
| nonce 去重（非 GET／HEAD 以 D1 `relay_nonces` 防重放） | **已實作**（migration `0003`；`docs/ops/relay-rollout.md` §1） |
| 失敗原因碼（次站缺 secret 的 `503` 分類＋跨站去重） | **Owner 已決**（驗收規則第 4 條；`relay-rollout.md:327`） |
| `method` 拆為實際動詞 | **已併**（PR #70；`relay-rollout.md:342`） |
| **覆蓋等式**（§1.3 公式與分量拆分） | **提案，未經 Owner 確認** |
| 樣本門檻 300／100／30 | **Owner 已決**（見 §2.4／§2.5） |

### 1.6 未決事項（需 Owner）

- 覆蓋等式的最終形式（分量是否再細分、是否要求逐類 E=L）。
- 「無法由程式量測」的入口（books／sync／static）是否接受以平台 invocation 總量替代，或需另立關聯規則。

---

## 2. 72h 觀察窗定義（含 Owner 決議）

### 2.1 窗口長度

- **N = 72 小時連續**；**可接受下限 24 小時**（僅當流量足以在 24h 內覆蓋所有主要路徑與站別時才可接受；低流量時 24h 可能完全沒有樣本）。
- 理由：涵蓋一個完整部署週期 ＋ 至少一次流量尖峰 ＋ 一個時鐘 skew 窗（±300s）；`none & identityPresent=true`（未簽章帶身分的殘留用戶端）會在數小時內逐步消失，72h 足以覆蓋週末／夜間低流量後的再現。
- **Owner 已決**：72h 觀察窗口採 **`transitional`**（模式為 `transitional`）。

### 2.2 起算條件

- 平台管線預檢通過（三站 invocation／應用日誌可查、100% 不取樣、保留期足以重查完整 72h）。`docs/ops/relay-rollout.md:285-297`
- **次站已隨簽章請求送出 edge secret，且主站 `A01_RELAY_EDGE_MODE=require` 已部署並驗證生效**，才起算 72h；在此之前 Gate 維持 `HOLD`。`docs/ops/relay-rollout.md:295,305`
- 起算須記錄候選版本 commit sha、三站生效設定（`A01_RELAY_MODE`、`A01_RELAY_EDGE_MODE`、金鑰／secret 綁定版本）與站點範圍。**Owner 已決**（驗收規則第 3 條；`relay-rollout.md:326`）
- 任何影響驗章或量測的變更（程式碼、執行期變數、路由、日誌程式或採集設定）→ **該窗口失效、重新起算**，不得沿用舊窗口的 72h。

### 2.3 通過條件（零容忍）

視窗內、受保護 API（呼叫 `getNormalizedAuth`、主站 `SITE_ROLE=primary`、非 health）須同時滿足：

- **(C1)** `result=invalid` 筆數 = 0（含 `site=unknown`／`pathClass=other`）。
- **(C2)** `result=none` 且 `identityPresent=true` 筆數 = 0。
- **(C3，建議)** `result=valid` 筆數 > 0（證明確實有簽章流量在跑）。
- `require` 下缺／錯 edge secret 的請求記 `relay.probe`，**不計入** `invalid` 零容忍；secret 相符但簽章失敗仍為 `invalid`。`docs/ops/relay-rollout.md:307`

> 為何不能只看 `none`：`none` 含**匿名流量**（`identityPresent=false`）；若只看 `none=0` 會把匿名誤判為異常。必須用 `identityPresent` 布林把「匿名」與「未簽章帶身分」分開——這正是 PR #61 加入 `identityPresent` 的原因。

### 2.4 樣本門檻（**Owner 已決**）

- Student `result=valid` ≥ **300**；Admin `result=valid` ≥ **100**（**僅自然樣本**）。
- 每個適用**非 GET 路徑 × 動詞** ≥ **30**（合成只補此 30，**不計入** 300／100）。
- 分列**實際 HTTP 動詞**（GET／HEAD／PUT／POST／DELETE／PATCH，其餘 `OTHER`）與路由模板。`none`、health、gate、CORS 拒絕不計入。`docs/ops/relay-rollout.md:309-310`
- 補樣只能使用另行授權、可辨識的測試流量，與真實流量分列；**staging 樣本不得混入 production 計數**。`docs/ops/relay-rollout.md:316`

### 2.5 Owner 決議清單（2026-10-16）

| 項目 | 決議 |
| --- | --- |
| 樣本門檻 | **300／100／30 採用**（Student valid≥300、Admin valid≥100、每非 GET 路徑×動詞≥30） |
| 觀察窗口 | 採 **`transitional`**（72h） |
| `method` 拆解 | 拆為實際動詞（GET/HEAD/PUT/POST/DELETE/PATCH，其餘 `OTHER`） |
| 合成／自然 | **分列**；合成**只補 ≥30、不計入 300／100** |
| 合成範圍 | **含 GET，且僅限 staging** |
| 窗後清理 | 窗口結束後**清除測試帳號與白名單** |
| 日誌保留 | **14 天**，且 **IP 遮罩、ID 雜湊** |
| 日誌匯出權限 | **AGY 與 Owner** |
| ingress 等價 | 以「**設定比對清單**」實作，由**非作者驗證者**判定 |
| 選項 C | **排除** |
| 回滾門檻 | W=30min、Nmin=100、Δauth=+1pp、Δ5xx=+0.5pp、K=3；**零容忍立即回滾**（執行人預設 Owner、AGY 監看） |
| Issue #72 | 維持 `OWNER_GATE=HOLD`；CDP 實測由貓聽執行 |

> 回滾門檻對照 `docs/ops/relay-rollout.md` §5.1（`relay-rollout.md:358-368`）；W/Nmin/Δ/K 的具體填入值以 Owner 登記為準，未填即 `HOLD`。

### 2.6 盲區（日誌看不到的）

| # | 盲區 | 等級 | 說明 |
| --- | --- | --- | --- |
| B1 | 平台日誌可用性未確認 | **HIGH** | 若平台不暴露日誌，整個門檻無法量測；**切 strict 前的阻塞項** |
| B2 | `off` 模式 0 行 | HIGH | `off` 時提前 return，完全不記錄；窗內誤設 `off` 會無聲無資料 |
| B3 | health 0 行 | MED | health 在程式內即排除 |
| B4 | 次站 delegate 0 行 | MED | `none & identityPresent` 只在主站可見 |
| B5 | 快取／CDN 繞過 | MED | 未到 Worker 的請求不記錄 |
| B6 | 抽樣 | MED | 破壞缺席證明 |
| B7 | 保留期上限 | LOW | 觀察窗須小於保留期，否則資料淘汰（Owner：14 天） |
| B8 | 主站直連流量 | LOW | 會被記為 `none & identityPresent=true`（可抓），但需流量確實到主站 |
| B9 | 時鐘偏差 | LOW | ±300s 外的合法請求會被記為 `invalid`，可能誤觸回滾 |

---

## 3. 合成取樣計畫

### 3.1 標記方式：`relay.verify` 日誌欄位 `synthetic`

- 於 `relay.verify` 日誌物件新增布林 `synthetic`，預設 `false`。`site/app/api/auth-helper.ts:96`
- **僅在同時滿足**兩條件時為 `true`：(1) 該筆 `result=valid`；且 (2) **已驗章身分**（`parsed.userId`／`parsed.email`，即簽章內容）完全等於伺服器端非 secret 白名單 `A01_SYNTHETIC_ACCOUNTS` 的某一項。`site/app/api/auth-helper.ts:343-351`
- **防外部偽造**：`synthetic` **不得**由請求標頭或 body 決定，只讀已驗章身分。`site/app/api/auth-helper.ts:336-342`
- **Fail-closed**：白名單未設定或為空＝一律 `false`；`invalid`／`none` 一律 `false`。`site/app/api/auth-helper.ts:323-329,345`
- **非 secret**：`A01_SYNTHETIC_ACCOUNTS` 為逗號分隔的測試帳號識別（email 或 relay user-id；去前後空白、不分大小寫、完全相等）；**只用於標記日誌，不授予任何權限**。`site/app/api/auth-helper.ts:306-314`
- **不洩漏**：白名單內容不得出現在任何日誌、health 或錯誤訊息；health 僅以 `syntheticAllowlist`（布林）回報是否已設定，不顯示項數或任何值。`site/app/api/health/route.ts:103`

### 3.2 計數口徑（分列）

- 合成樣本＝同窗內 `evt=relay.verify AND synthetic=true`；自然樣本＝同窗內 `synthetic=false`。
- **合成樣本不計入**：(a) Student 300／Admin 100；(b) 使用者面向失敗率之分子／分母；(c) 自然流量的 72h 覆蓋等式 E=L。
- 合成樣本**另以**「合成窗 E_syn = L_syn」單獨核對完整性（每個路徑 × 方法 `valid` ≥ 30）。
- 報告中合成與自然**必須分列**並標明來源，**不得**混算後宣稱自然流量達標。
- 合成流量**不補**零容忍項：`invalid=0`、`none & identityPresent=0` 仍須在**自然流量**的 72h 窗內成立。

### 3.3 需補樣清單（非 GET 路徑 × 方法，各 ≥ 30 `valid`）

| 站別 | 路由模板 | 方法 | 分類 | 目標（合成） |
| --- | --- | --- | --- | --- |
| Student | `/api/student/progress` | PUT | student | ≥ 30 |
| Admin | `/api/admin/books` | POST | admin | ≥ 30 |
| Admin | `/api/admin/books` | DELETE | admin | ≥ 30 |
| Admin | `/api/admin/books/[id]` | DELETE | admin | ≥ 30 |
| Admin | `/api/admin/books/upload` | POST | admin | ≥ 30 |

- GET 路徑以自然流量為主；**Owner 已決：合成含 GET**（依指示納入），其餘 GET 預設不補。
- **注意**：`relay.verify` 的 `pathClass` 只分 `student`／`admin`／`other`，**無法區分同方法的不同子路由**（例：`POST /api/admin/books` 與 `POST /api/admin/books/upload` 同為 `method=POST`、`pathClass=admin`）。補樣清單與計數須**輔以主站 invocation／路由證據（含 URL 模板）**交叉比對；無法區分即該項 `HOLD`（與 `relay-rollout.md:342` 一致）。
- `OPTIONS`（CORS 預檢）不呼叫 `getNormalizedAuth`、不產生 `relay.verify`；`/api/internal/sync/*` 走獨立驗證；health 不記錄——皆不在本清單。

### 3.4 環境與前置（staging first）

1. **一律先在 staging**（或獨立合成資源）執行；`PRIMARY_ORIGIN` **不得**指向 production 主站。
2. **ingress 等價為前置閘門**：須先確認 staging 與 production 的 ingress／relay 行為等價（含平台是否剝除外部帶入的 `oai-*`、edge 閘行為）；**未確認前不得對 production 做任何補樣**。**Owner 已決**：以「設定比對清單」實作，由非作者驗證者判定。
3. 三站版本與執行期變數先就緒；主站 `relayKeys ≥ 2` 且 student／admin 各自至少一把有效金鑰；主站 `adminAllowlist=configured`。
4. 若 staging 結果與 production 不等價，合成結果**不得**推論 production，該項 `HOLD`。

### 3.5 授權、分工、節奏、停止與清理

- **授權**：**一次授權涵蓋整個 72h 窗口**（站別、路由／方法、每項 ≥ 30、總量上限、時間窗起訖）；執行期間不逐次再核。超出範圍即停止並回報。
- **分工**：執行者＝AGY（建立測試帳號、管理執行期變數含 `A01_SYNTHETIC_ACCOUNTS`、注入流量、負責停止與清理）；結果驗證＝**非 AGY、非作者**（合成相關 PR 與結果的驗證不得由 AGY 執行）。
- **節奏**：逐「路由模板 × 方法」執行，每項目標 ≥ 30 `valid`；**分時段**（例：每小時一批）避免瞬間灌量；每批前後留空窗，便於以時間窗切分合成樣本；全程在 staging。
- **停止條件**（任一成立即暫停並回報）：(1) 出現非預期狀態碼或 `relay.verify result=invalid` 上升；(2) `synthetic=true` 出現在非白名單帳號，或白名單帳號出現 `synthetic=false`（標記異常）；(3) 觀察到影響真實使用者；(4) 觸及任何 production 資源（立即停止）；(5) 授權窗到期或 Owner／維運指示停止。
- **清理**：刪除本次建立的合成資料列（以 run manifest 記錄的 ID 為準，先建後刪）；刪除 staging R2 上的合成物件（或標記可回收）；依 **Owner 已決**「窗口結束後清除測試帳號與白名單」移除／停用測試帳號與 `A01_SYNTHETIC_ACCOUNTS`；保留脫敏彙總與 manifest 作為證據。

### 3.6 證據與脫敏（`docs/evidence/`）

- 位置：repo `docs/evidence/`（與真實流量證據分開存放）。
- **只存脫敏彙總與 manifest**：manifest 含 `run_id`、時間窗（UTC 起訖）、站別、路由模板、方法、預期／實際 `valid` 數、執行者、授權依據；彙總含每「路徑 × 方法」的 `synthetic=true` 計數、`E_syn=L_syn` 核對結果、零容忍項在自然流量的核對結果。
- **脫敏規則**（**Owner 已決**）：IP 遮罩、任何 ID 一律雜湊、**不存原始請求內容**（不存 body、query、標頭、cookie、Authorization）。日誌保留 **14 天**；匯出權限限 **AGY 與 Owner**。

### 3.7 執行工具

| 工具 | 位置／狀態 | 用途 |
| --- | --- | --- |
| 合成流量注入腳本 | **PR #74（尚未合併）**；staging-only、dry-run 預設、需明確 `--execute` | 產生受控合成流量 |
| 72h 覆蓋彙整 | `scripts/a01-coverage/`（已於 #76 併入） | 讀脫敏日誌、輸出自然／合成分列與覆蓋等式核對 |

> `scripts/a01-coverage/` 的門檻與覆蓋等式輸出皆標示「提案，未經 Owner 確認」；本文件 §2.4 已把 300／100／30 記為 Owner 已決，落地時應更新該標示（屬後續程式 PR，非本文件範圍）。

---

## 4. 引用清單（file:line @ `b9ee98e3`）

| 引用 | 位置 |
| --- | --- |
| `relay.verify` 記錄函式與欄位 | `site/app/api/auth-helper.ts:82-101`（`evt`/`result` :94、`site` :90-91、`identityPresent` :95、`method` :92、`pathClass` :86-89、`synthetic` :96） |
| 僅主站記錄／每 Request 一行／logger try-catch | `site/app/api/auth-helper.ts:84,98-100` |
| 合成標記工具函式 | `site/app/api/auth-helper.ts:306-351`（`parseSyntheticAccounts` :323、`isSyntheticAllowlistConfigured` :332、`isSyntheticIdentity` :343） |
| health 觀測欄位 | `site/app/api/health/route.ts:88-89`（`relayMode`/`relayKeys`）、`:100`（`adminAllowlist`）、`:103`（`syntheticAllowlist`） |
| edge 閘 `relay.probe` | `site/lib/relay-edge-gate.ts:77` |
| 覆蓋等式實作 | `scripts/a01-coverage/core.mjs:13-15,21-26`；`scripts/a01-coverage/README.md:14` |
| Gate 條文／路由盤點／E=L／四條驗收規則 | `docs/ops/relay-rollout.md:283-354`（§4.4；四條規則 :320-327、路由盤點 :329-348、E=L :346） |
| 回滾門檻 | `docs/ops/relay-rollout.md:358-368`（§5.1） |
| 程式碼交叉核對 | `docs/ops/relay-rollout.md:438-454`（§9） |

---

## 5. 不變更項與 HOLD

- 本文件**不改變** `docs/ops/relay-rollout.md` 的 300／100／30 與 §5 回滾數字之**語意**（回滾 W/Nmin/Δ/K 具體值仍以 Owner 登記為準）。
- 合成補樣**不能**替代「無異常」的缺席證明：`invalid=0`、`none & identityPresent=0` 仍須在**自然流量**的 72h 窗內成立；合成只補足**有效樣本覆蓋**。
- Strict Release Gate 維持 **`HOLD`**；**選項 C 排除**；Issue #72 維持 `OWNER_GATE=HOLD`（CDP 實測由貓聽執行）。
- 全程：不部署、不讀 secrets、不碰 migration `0003`、不改程式（本文件僅文件）。
