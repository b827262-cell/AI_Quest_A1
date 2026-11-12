# Sites 執行期變數注入：staging 驗證計畫（Issue #46）

狀態：**計畫與本機觀察；尚未部署或驗證 Sites**。本階段的程式基準為 `82ec1f715d983fde3254bdb36989360b546c2891`；本文件的提交只新增文件，不改 site 程式。下列步驟須在 Owner 指定的隔離 staging 專案執行，不能指向或改動 production。不要使用 production D1／R2、真實身分、真實資料或 production 主站作為 `PRIMARY_ORIGIN`。

## 程式來源與缺值行為

- `site/worker/index.ts` 的 `fetch(request, env, ctx)` 每次請求都把 `env.SITE_ROLE`、`env.SITE_NAME`、`env.PRIMARY_ORIGIN`、`env.GIT_SHA` 複製到 `globalThis`，包含 `undefined`；`backend-client.ts` 每次讀取 global，未有值才回落 `globalThis.__env__`。不是從 hostname 或 `process.env` 直接推斷站別。`/api/health` 對這些欄位依序讀 global、`__env__`、`env` 的 global 容器；這些 fallback 的存在**不能證明** Sites 會提供它們。
- `site/.openai/hosting.json` 宣告一個 project ID 及 D1／R2 binding 名稱，沒有這四個值。`site/deploy/targets.json` 與 `docs/ops/three-site-runbook.md` 是三站期望配置：backend 為 `primary/backend`、student 和 admin 為對應 `secondary`，次站的 `primary_origin` 是指定主站 origin；這些檔案不是 Worker 執行期自動注入的證據，也不得把其中 production 值用作本測試。
- `SITE_ROLE` 與 `SITE_NAME` 都缺少時進入 `standalone`、不代理；**這不是全面 fail-closed**，仍使用既有本地行為。只缺一個、或角色與站名不成對時為 `misconfigured`；除 health 外的 API 回 503 `site_misconfigured`。`/api/health` 仍回 200，不能只看 HTTP 狀態判斷配置正確。
- primary/backend 忽略 `PRIMARY_ORIGIN`。secondary/student 或 secondary/admin 需要純 HTTPS origin；缺少或不合法時 health 的 `primaryOrigin` 為 `null`，production 的次站代理請求回 503 `backend_disabled`，不對外轉送；非 production 原本不執行代理。
- `GIT_SHA` 供 health 識別，必須是 7–40 位十六進位；否則退回注入的 build identity，再無有效值為 `unknown`。它不會令路由 fail-closed，也不是單憑回傳值證明實際 build SHA 的不可偽造憑據。

## 本機證據（不代表 Sites 行為）

在全新 worktree 的 `82ec1f7`、以 `npm ci --ignore-scripts` 安裝後，清除這四個 shell 變數執行 `npm run build`（含 size gate），再啟動 `node scripts/local-qa-server.mjs`；該腳本只綁 `127.0.0.1:3002`，測試後已停止。只讀取 `/api/health` 下列非秘密欄位：

| local-qa-server 啟動環境 | HTTP | role / site / primaryOrigin | gitSha / identitySource | d1 / r2 |
| --- | --- | --- | --- | --- |
| 四變數未設定 | 200 | `standalone` / `null` / `null` | `unknown` / `fallback` | `bound` / `bound` |
| shell 設為 `secondary`、`student`、`https://primary.staging.example`、40 個 `1` | 200 | `standalone` / `null` / `null` | `unknown` / `fallback` | `bound` / `bound` |

原因是 local-qa-server 的 `workerEnv` 只有模擬 DB、R2、ASSETS，**不轉交這四個 shell 變數**；`bound` 是 dummy 物件，不是真實資源。用相同 build 在隔離 Node 程序直接呼叫 `worker.fetch` 並明確提供非秘密的 Worker `env`：`primary/backend` 及 `secondary/student` 各自顯示指定 role/site；後者顯示指定 staging origin；兩者的測試 SHA 顯示於 `gitSha`，`identitySource=environment`。不給 env 則 `standalone`、`gitSha=unknown`；只給 `SITE_ROLE=primary` 為 `misconfigured`；給 secondary/student 而不給 origin 時 health 仍 200，但 `primaryOrigin=null`。直接注入是程式行為的對照，不是 Sites 實測。

## Owner 需先提供或操作

1. 指定獨立 staging Sites 專案與網址、允許測試時段、操作者及其存取方式；確認不復用 production 專案、網域、D1、R2 或主站。若需模擬 secondary，提供**專用隔離 staging HTTPS origin**，不能指向 production。
2. Owner 自行登入或使用其核准的 Sites 部署介面，確認該平台的專案級非秘密變數是否可在**不重新建置**下修改，並提供可重現的官方操作步驟／部署指令；不要將帳號、token、secret 或其值貼入 PR、對話、命令輸出或測試記錄。此文件不預設平台支援任何未核實的指令或注入方式。
3. Owner 確認可還原的 staging 前一版 artifact／revision、前一版非秘密變數與還原方法；確認測試權限與流量隔離後才執行。先記錄是否已有資源綁定，但不讀取其憑證。避免對 production 操作或執行 migration。

## 待 Owner 執行的 staging 實測

1. 在隔離環境從同一個明確 commit 建置 **一次** site artifact，記下完整 source commit、build 工具版本及 `package:size-gate` 的 `PACKAGE_SHA`；此 hash 是本次待上傳 `dist` 內容的指紋。Owner 以其核准的 Sites 操作將該**同一份** artifact 部署至 staging，記錄平台 revision、實際部署 artifact 識別及時間。不修改 `.openai/hosting.json` 指向 production，也不從工作樹寫入 production manifest。此處的 plan 不提供未經確認的部署命令。
2. 設一組不含秘密且可辨識的 A 值，例如 `SITE_ROLE=secondary`、`SITE_NAME=student`、`PRIMARY_ORIGIN=https://<owner指定的隔離staging主站>`、`GIT_SHA=<本次 build 完整 SHA>`。使用 HTTPS GET `/api/health`，記錄時間、HTTP 狀態及 `role`、`site`、`primaryOrigin`、`gitSha`、`identitySource`、`d1`、`r2`；不得記錄其他環境值或身分資料。以不快取方式重複查詢（例如 `Cache-Control: no-cache`、不同無敏感資訊的 query），確認不是單一快取回應。
3. **關鍵對照：不重新 build、不改 artifact**，由 Owner 僅把 staging 執行期非秘密變數改為 B 值，例如 `SITE_ROLE=secondary`、`SITE_NAME=admin`、同一隔離 origin、同一 build SHA；記錄平台操作是否產生新 revision／重啟，以及平台可取得的 artifact 識別與 hash。重複 GET health，觀察是否由 student 變為 admin。若平台必須重新部署相同 artifact 才套用環境，也記下此事；仍可測試同 artifact 的 runtime binding，但不能宣稱是無重部署即時生效。
4. 可在隔離 staging 專案進行缺值負向對照：撤掉 role/name，觀察 health 為 `standalone`；只給 role 為 `misconfigured`，且以無副作用 GET 確認非 health API 回 503；secondary 移除 origin 後確認 `primaryOrigin=null`，並在已確認 production 模式的隔離專案以無副作用的自身 API GET 驗證 503 `backend_disabled`、不連外。負向對照必須限定隔離環境；不要用這種方式停用 production。
5. 恢復或回滾後重複 health GET，核對 revision、role/site、origin、gitSha 及 binding 狀態。記錄具體時間、狀態與觀測值，區分尚未驗證、平台不支援、配置錯誤與測試失敗。

## 判準與回滾

- **執行期注入有證據**：同一份 artifact 在 A、B 間沒有重新建置，平台確認變更的來源是 runtime configuration，且多次 health 顯示各自正確 role/site/origin 與同一有效 SHA；平台 revision／artifact 身分與操作紀錄可追溯。只有健康頁顯示固定 A 值，不能證明注入時機。
- **未證實或失敗**：值維持舊值、`standalone`／`misconfigured`、`primaryOrigin=null`、`gitSha=unknown`／不符、意外 production 資源綁定，或無法證明使用同一 artifact 時，停止並回報；若平台只支援 build-time 值，標為待設計，不得假設可用：目前 Worker 在每次請求會用缺失的 `env` 值覆寫 global，build-time 方案仍需另行設計及測試。
- **回滾**：Owner 以事前記錄的 staging revision／artifact 和非秘密設定恢復，驗證 health 與隔離綁定；如無法安全恢復，停止 staging 流量並回報 Owner。不要刪除 production 變數或改 production routing。測試不要求登入、部署命令、寫入資料或執行 migration 在本階段發生。
