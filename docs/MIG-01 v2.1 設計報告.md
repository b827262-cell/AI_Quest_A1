A-01 · 單一 Worker 遷移 · 設計報告

# TASK-MIG-01 v2.1

設計草案,尚未實作 OpenClaw 非作者審查 PASS 6/6 文件交付,不等於遷移驗收 Gate 0/9

基準版本 main

80ee217c64e0c281f74bf26213ffb4ddc8905b25

報告全文 SHA-256(86 行)

b2025dc4a3638135681aa7ea5dc84a958339faa424c4e70dda1648f373ca882f

作者 / 審查者

Codex-Work-E500 / E500 OpenClaw(PM 抽核相符)

依據

Owner 決議 10(email 主鍵)、16–17

章節 [§1 單一 Worker](#s1) [§2 切換順序](#s2) [§3 Access JWT](#s3) [§4 G1 防繞過](#s4) [§5 回滾 SOP](#s5) [§6 D1 資料保護](#s6) [審查結果](#review) [待辦與缺口](#open)

## §1單一 Worker 範圍與逐檔刪改計畫

目標:單一 Worker 接收站點頁面與 `/api/*`,並持有唯一的正式 D1/R2 綁定。切流前盤點三站所有 hostname、route、版本與寫入來源;切流後任一舊站若仍能寫入,視為遷移失敗。以下是未執行的程式計畫,不構成刪除授權。

| 基準檔案 | 設計動作 |
| --- | --- |
| `site/app/api/backend-client.ts` | 將 secondary 代理、`PRIMARY_ORIGIN`、次站前綴轉送與三站角色判定改為單站本地路由;保留 `classifyApiPath` 的歧義路徑拒絕。先做路由矩陣,不直接刪整檔。 |
| `site/lib/relay-signature.ts` `site/lib/relay-verification.ts` | Access JWT 驗證接替簽章與驗章後,才移除 HMAC canonicalization、時間戳與雙鑰邏輯;安全日誌語義改為 Access 驗證結果。 |
| `site/lib/relay-edge-gate.ts` `site/lib/relay-edge-config.ts` | 預定刪除 relay edge secret 檢查;刪前須同時處理 `site/worker/index.ts:5,89–91` 的 import、呼叫與 `Request \| Response` 分支。 |
| `site/app/api/health/route.ts:6–7,20–29,69–95` | 移除 `countValidEdgeSecrets`、`readEdgeGateMode`、`readEdgeSenderSecret`、`edgeGateBindings()` 等欄位;改為不洩漏位址或 token 的 `authMode=access-jwt`、驗證器就緒狀態、單站 D1/R2 綁定與部署 SHA。 |
| `site/worker/index.ts` `site/app/api/auth-helper.ts` | Worker 入口先處理可信 Access JWT 再交給 API;身分由已驗簽 claims 建立;移除信任外來 `oai-*`、`x-a01-relay-*` 的路徑;管理員仍用伺服端 allowlist。 |

### 七個測試檔逐檔處置

| 測試檔 | 處置 |
| --- | --- |
| `relay-canonical` | 移除 HMAC canonical 字串測試;變形 URL、大小寫、重複斜線、百分號編碼的拒絕案例搬到單站 API 路由測試。 |
| `relay-edge-gate` | 刪除 edge secret / accept / require 斷言;新增匿名、偽造 header、無效 JWT、歧義路徑與 health 例外的入口測試。 |
| `relay-logging` | `relay.verify` / `relay.probe` 計數改為 Access 驗證與拒絕事件;日誌不含 JWT、email、cert 或 secret。 |
| `relay-secondary` | 移除代理、簽章、次站缺 secret 舊案例;新增單站本地 API、禁止外站直寫與舊 hostname 不可達的整合案例。 |
| `relay-sign-verify` | 移除 HMAC 簽驗案例;新增 JWT kid、簽章、iss、aud、exp、nbf、輪替與抓證失敗案例。 |
| `relay-verify` | off / transitional / strict、雙鑰與 `oai-*` 回退案例改為 Access fail-closed、email 主鍵與管理員 allowlist 案例。 |
| `three-site-topology` | 改寫為單站 hostname、唯一 D1/R2 綁定、路由與舊入口隔離;不可只刪檔而喪失拓撲驗收。 |

另須清點:`api-runtime`、`environment-capture`、`site/package.json` 測試清單、`site/deploy/targets.json`、環境 manifest 與 `docs/ops/three-site-runbook.md`。實作前以 `rg` 重查全 repo。

## §2切換順序與資料邊界

1. 建立可獨立驗證的單站候選版本與唯讀演練。
2. 完成 §3 身分驗證、§4 入口封堵、§6 快照與對帳基線。
3. 才可向 Owner 分別申請停寫、切流、開寫的個別授權。

舊三站與新單站不能同時成為正式寫入者。讀寫 API、背景同步、排程、管理端與內部 sync 都納入寫入來源清冊,任何未列來源使切換 HOLD。新舊 D1 的 database ID、綁定名稱、schema 版本與資料來源需由平台證據確認,不能從 repo 或 health 的 `bound` 推定兩者相同。

## §3Cloudflare Access JWT 驗證

Worker 入口讀取 `Cf-Access-Jwt-Assertion`,即使 Access 已在邊緣擋過仍自行驗簽。不使用未驗證的 `oai-*`、`Cf-Access-Authenticated-User-Email`、JWT payload 或 `CF_Authorization` cookie 建立身分。公鑰只從固定允許的 `https://<team-domain>.cloudflareaccess.com/cdn-cgi/access/certs` 取得,不從 token 的 `iss` 或任意 header 動態拼接。

### 驗證順序

1. 限制 token 長度與 JWT 三段格式。
2. 僅接受 `RS256`,拒絕 `none` 或由 token 自行指定演算法。
3. 讀 header 的 `kid`,只在已取得的 `public_certs` 以 exact `kid` 選鑰;拒絕重複或缺失。
4. 驗簽後核對固定 `iss`、精確 AUD、`exp`、`nbf`、`iat` 與非空有效 email。
5. 身分主鍵 = 已驗證 JWT 的 email(trim 後小寫),並做唯一性/碰撞檢查;管理員另比對 `ADMIN_EMAILS` exact allowlist。

| 項目 | 草案 |
| --- | --- |
| 公鑰快取 | 每個 Worker isolate 共享已驗證公鑰與同一個進行中的抓取 Promise,跨請求複用;TTL 建議 5 分鐘。 |
| `kid` 不命中 | 立即強制重抓一次,單請求最多一次;新舊 cert 並存時各按自己的 `kid` 驗簽。 |
| 失敗處理 | TTL 到期或首次抓取失敗、無有效 cert、未知 `kid`、驗簽/claims 失敗,一律 fail-closed(401/503),不進 API 或 D1。stale-while-error 預設不用。 |
| 時鐘偏移 | ±60 秒,只用於 nbf/iat/exp 邊界,不延長已到期 token 的有效性。 |
| 監控 | 只記失敗類別、`kid` 是否命中、快取年齡與 trace ID;不記 token、email、cert 內容。 |

## §4G1 入口防繞過驗證程序

平台負責人先列出單站 Worker 的 custom domain、route、`workers.dev`、Version URL、Preview URL、Deployment URL,以及舊三站所有仍可達入口,截取 Domains & Routes 與 Access 保護設定的證據。若停用 `workers.dev`,Wrangler 設定也須持久設定 `workers_dev=false`;關閉它不會自動關閉其他版本 URL,需逐項核查。這是未執行的程序,不是現場結果。

### 在 staging 對每個入口

用確切 URL 對 `GET /api/health`、`/api/student/me`、`/api/admin/me`、`/api/internal/sync/runs` 發送三組**唯讀**請求:

- 無 cookie / 無 assertion
- 偽造 `oai-*`、`x-a01-relay-*` 或無效 assertion
- 經核准的合法 Access 身分

以 `curl -i --max-redirs 0` 保留 status、`Location`、content-type、response body 摘要與 trace ID;不得把真實 JWT 印入證據。

| 結果 | 判定 |
| --- | --- |
| 禁用/未保護入口仍回應 app health、學生/管理 API 資料 | G1 FAIL |
| 入口清單、設定或 body 證據缺漏 | G1 HOLD |
| 被封入口回 Cloudflare / Access 阻擋頁或預期拒絕 JSON;偽造憑證不出現 app 身分資料;合法請求只在預期入口回應且身分正確 | 可進入 PASS 評估 |

只看到 403 不足以通過,還須確認 body 是 Access 阻擋頁或預期拒絕 JSON,絕不能是 `/api/health` 的 `status:ok`、`gitSha`、`d1` 或任何 API 資料。作者自評 PASS 不採計;生產環境只做已核准的唯讀同等驗證。

## §5回滾 SOP 與可操作門檻

沿用 `docs/ops/relay-rollout.md:368–370` 的 Owner 數字作**切換期草案**。

| 參數 | 值 | 意義 |
| --- | --- | --- |
| `W` | 30 min | 觀測視窗 |
| `Nmin` | 100 | 每站每路徑最少請求數;N 未達 100 不可當作零錯誤 |
| `Δauth` | +1pp | 401/403 相對已登記基準;達門檻即暫停並評估回滾 |
| `Δ5xx` | +0.5pp | 達門檻即觸發回滾 |
| `K` | 3 | 連續 3 個 W |

遷移後 `relay.verify` 類別可能消失,故兩項零容忍改為:**已驗簽前身分被採用**、**無效 JWT 仍進 API**,任一筆即刻停止切換及回滾;可重現合法使用者被拒仍零容忍。未授權寫入、雙寫、D1 差異超出 §6 門檻或快照不可驗,立即停寫並進入回滾決策,不等 W/Nmin/K。

### 操作順序(執行者沿用 AGY,Owner 事後確認)

1. 記錄觸發時刻、實際 SHA、入口、錯誤率、D1 bookmark / 快照與最後成功寫入時刻。
2. **先停新舊所有寫入**(API、排程、sync、重試佇列),確認沒有 in-flight write。
3. 執行 §6 新舊資料差異報告與快照核驗。
4. 只切讀流量到 Owner 指定且平台核驗的版本/入口,兩邊保持唯讀。
5. 需補寫的資料按 §6 核准方案處理,達門檻後才恢復單一寫入者。
6. 用 health、合法學生/管理員唯讀請求、D1/R2 指向、401/403/5xx 基準與資料對帳驗證。
7. 記錄完成時間、實際 SHA、操作者與 Owner 事後確認;Gate 回 HOLD 待重驗。

不可沿用 relay 時代「改 `A01_RELAY_EDGE_MODE=accept`」當單站回滾;新設計沒有此開關。切回舊程式不會自動讓舊 D1 取得新 D1 的寫入。

## §6D1 資料保護與新舊資料對帳

### 6.1 停寫與可驗證快照

切換/回滾前由執行者阻斷所有寫路徑,等待或明確取消 in-flight write,記錄 UTC 停寫時間 `Tstop`。在新舊 D1 各自取得 database ID、schema 版本、Time Travel bookmark;對可用資料庫匯出唯讀快照,記錄大小、SHA-256、匯出時間、bookmark、工具版本、行數與存取控制,並重新讀取檢查可解析性。Time Travel bookmark 只是復原點證據,不能代替獨立匯出/差異報告;正式庫 restore 會覆寫資料,須另案授權。無可驗快照即 HOLD。

### 6.2 最後成功寫入與差異報告

對每種寫入來源記錄最後**已確認提交**時間 `Tlast`、請求/事件 ID、主鍵與來源庫;不能只用請求開始時間或 `updated_at` 推定提交成功。缺少提交審計時以快照與日誌交叉求保守區間,不確定寫入列為待人工覆核,不宣稱 RPO=0。依表列 schema、主鍵、行數、最小/最大更新時間、每列穩定雜湊,再分類:

- 只在舊庫 / 只在新庫
- 內容相同 / 內容衝突
- 刪除標記或缺列、R2 物件引用不一致

報告每類數量、脫敏樣本 ID、完整差異清單的受控位置與雜湊。至少覆蓋學生帳號/進度、書籍與檔案、管理資料、內部 sync 狀態。email 主鍵移轉需先查重、大小寫碰撞及舊 user-id 對照,禁止推測合併。

### 6.3 補寫 / 恢復與 RTO / RPO 草案

預設不做整庫覆寫。「只在新庫」或新庫較新的已確認寫入,從已驗證新庫快照抽取,經欄位映射、外鍵順序、去重鍵與衝突規則審核後,在 staging 重放並重跑行數/雜湊/業務唯讀檢查,再申請 production 補寫授權。衝突列逐筆決策並保留兩邊原值。本文件**不授權 restore**。RTO / RPO 以演練實測,不得宣稱零資料損失。

### Owner 待填核准欄位

| 欄位 | v2.1 原文 | Owner 11:19 建議草案(D19,待 PM 補證後確認) |
| --- | --- | --- |
| 資料保護責任人 / 代理人 | ＿＿＿＿ | PM 統籌;資料操作人員與獨立 Reviewer 另指定;Owner 核准 |
| 對帳判定門檻 | ＿＿＿＿ | 正式資料不允許未解釋的遺失、重複或錯誤 |
| 補寫准入門檻與衝突裁決人 | ＿＿＿＿ | 隔離環境 dry-run 與對帳通過後,另請 Owner GO |
| RTO / RPO 目標 | ＿＿＿＿ | RTO ≤ 60 分鐘;RPO 為 0 筆已確認寫入遺失;須以演練驗證 |
| 正式庫快照保存位置與存取責任人 | ＿＿＿＿ | 受限權限的私人備份儲存區,附 SHA-256 與還原驗證紀錄 |

需對齊:草案的「RPO 0 筆」是目標,而 v2.1 §6.3 要求在演練完成前不得宣稱零資料損失。確認時應把 RPO 0 寫成「待演練驗證的目標」。

## 非作者審查結果

E500 OpenClaw,唯讀(僅讀 Slack 全文與 `gh api` 讀取 `80ee217c`),行號為其自 gh api 原文計數。

| 項目 | 判定 | 依據摘要 |
| --- | --- | --- |
| §1 health 相依、worker:89、7 測試檔 | PASS | `route.ts:6` 與 `:7` 為 import,`:22–29` `edgeGateBindings()`,`worker/index.ts:5,89–91` 與報告一致。 |
| §3 kid / TTL / fail-closed / ±60s | PASS | 三者不衝突;kid 未命中只強制重抓一次。 |
| §4 入口驗證程序 | PASS | 設定位置、請求、body 判定、FAIL/HOLD 條件皆有。 |
| §5 沿用 368–370 與單站零容忍 | PASS | 數值同值;①–⑦ 步驟可執行。 |
| §6 停寫 / 快照 / Tlast / 差異 / 補寫 | PASS | 無「切回舊版自動拿到新資料」假設;五個 Owner 空欄保留。 |
| 是否超出 Owner 決議 | PASS | email 主鍵;不授權 restore / 部署。 |

## 待辦與缺口(實作前補)

- **401 與 503** 的觸發條件對照:審查指出尚未寫明。PM 準備稿草案:無/無效 JWT → 401;驗證設定缺或 certs 取不到且無有效快取 → 503。
- **另 4 個測試** 未進逐檔清單:`auth-hardening`、`phase3c-shared-backend`、`sync-internal-api`、`environment-alignment`。
- **PM 補充發現(沙盒基準,LOCAL ONLY):**`phase3d-r2-storage`(48 處 `oai-`)、`d1-persistence`(6)、`three-site-topology` 也可能受影響,建議納入影響分析。未改動的 main 於沙盒 build 成功,`npm test` 清單 26 檔 453 通過、0 失敗。
- **範圍差異:**v2.1 針對 `site/` Worker;Owner 16:22 要求的 `127.0.0.1:5173/login` 登入改造,標的是 `apps/AI-Stu-R1` 學生網站,與 v2.1 共用 §3 的 Access JWT 規格,但不共用程式碼。
- §6 五個 Owner 空欄待 PM 補 5 項程序證據後確認。

部署、合併、正式資料寫入與 Cloudflare 設定變更均未放行;MIG-C01 實作與 commit / push / PR 仍需 Owner 逐項確認。

資料來源:Slack #a-01-v01 討論串(Codex v2.1 全文 1/1、OpenClaw R-MIG01v2.1 審查)。頁面整理:PM,2026-10-21。