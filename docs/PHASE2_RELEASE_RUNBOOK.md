# Phase 2 Release Runbook

> **版本**：1.1.0（R15 退件修正：F1–F7／F12）
> **對應基線**：HEAD `23b2d57`，branch `feat/front-back-integration-p1-p3`
> **最後更新**：2026-11-20

> **權限前提（F6）**：本章包含 `systemctl`、`nginx`、`cp /etc/nginx/…` 等需 **互動 sudo/root** 權限的操作。在非互動環境（`sudo -n` 要求密碼）下，這些步驟無法執行，請改用 `reset-ai-smartbook.sh`（開發/測試環境；無需 sudo）或聯繫系統管理員。`reset-ai-smartbook.sh` 的功能與權限需求尚待逐行閱讀驗證，此處僅列為「未驗證選項／未知」。

> **註（F12）**：發布門控中的 `Rollback Procedure Available` 步驟為 `fileGate`（`phase3a-release-gate.mjs:44-53` 的 `existsSync`），**僅驗證三份檔案存在，不代表回滾流程已驗證可操作**。

## 1. 發布前檢查

### 1.1 環境確認

| 項目 | 檢查方式 | 期望結果 |
|------|----------|----------|
| Node.js 版本 | `node -v` | `v22.x` |
| pnpm 版本 | `corepack pnpm@9.15.0 -v` | `9.15.0` |
| 依賴完整性 | `corepack pnpm@9.15.0 install --frozen-lockfile` | exit 0 |
| Lockfile 完整性 | `sha256sum pnpm-lock.yaml` | 與基線一致 |

### 1.2 發布門控檢查

執行完整發布門控（`scripts/phase3a-release-gate.mjs`）：

```bash
pnpm release-gate:phase3a
```

該腳本會依序執行以下檢查（定義於 `scripts/phase3a-release-gate.mjs`）：

1. **Local Test**：typecheck、release-script typecheck、lint、release-script lint、unit and integration tests、build
2. **Workspace Symlink Health**：`scripts/check-workspace-symlinks.sh`（`phase3a-release-gate.mjs:76`，嚴格模式；broken symlinks 或絕對 `/data/` 連結將 FAIL）
3. **Database Preflight**：`pnpm db:preflight:phase2`（`scripts/phase2-db-preflight.ts`）
4. **Rotation Implementation Tests**：credential rotation 單元測試
5. **Target DB Credential Verification**：`pnpm credential-key:verify`（`scripts/credential-key-rotation.ts --verify`）
6. **Browser UI E2E**：`pnpm e2e:admin-providers`（`scripts/admin-provider-ui-e2e.mjs`）
7. **Staging HTTP Smoke**：`pnpm smoke:phase3a`（`scripts/phase3a-staging-smoke.ts`）
8. **Provider Vault Live Smoke**：`pnpm smoke:provider`（`scripts/provider-live-smoke.ts`）
9. **Production Verification**：`pnpm production:verify:phase3a`（`scripts/production-verification.mjs`）
10. **Rollback Procedure Available**：`fileGate`（`phase3a-release-gate.mjs:44-53`）**僅驗證三份檔案存在**（`existsSync`），不代表回滾流程已驗證可操作：
    - `docs/PHASE2_RELEASE_RUNBOOK.md`（本文件）
    - `docs/PHASE3A_PRODUCTION_VERIFICATION.md`
    - `scripts/credential-key-rotation.ts`
11. **Rollback Restore Rehearsal**：回滾演練 artifact 驗證

**通過條件**：所有 gate 狀態為 `PASS` 或 `BLOCKED`（非 `FAIL`）。

### 1.3 資料庫預檢

```bash
pnpm db:preflight:phase2
```

此命令執行 `scripts/phase2-db-preflight.ts`，檢查：
- 資料庫連線與 schema 版本
- 必要資料表存在性
- 資料一致性

### 1.4 凭证安全確認

```bash
# 驗證現有凭证加密金钥
pnpm credential-key:verify
```

此命令執行 `scripts/credential-key-rotation.ts --verify`，需要環境變數：
- `AI_CREDENTIAL_ENCRYPTION_KEY`：[REDACTED]，見 Vault/環境變數

## 2. 發布步驟

### 2.1 靜態資產建構

```bash
# 建構所有模組
pnpm build
```

### 2.2 服務部署

#### 方式一：systemd 服務（生產環境）

**前置：安裝 systemd unit 檔案（F5）**

首次部署或 unit 檔案變更時，需先將 `deploy/systemd/*.service` 複製至 `/etc/systemd/system/`：

```bash
# 複製 systemd unit 檔案（實際檔案以 deploy/systemd/ 目錄內容為準）
sudo cp deploy/systemd/ai-adm-d1.service /etc/systemd/system/ai-adm-d1.service
sudo cp deploy/systemd/ai-stu-r1.service /etc/systemd/system/ai-stu-r1.service

# 重新載入 systemd 配置
sudo systemctl daemon-reload

# 啟用服務開機自啟（可選）
sudo systemctl enable ai-adm-d1 ai-stu-r1
```

> **環境限制**：本機 `/etc/systemd/system/` 下無 `ai-adm-d1.service` 或 `ai-stu-r1.service`，此步驟僅適用於已配置 systemd 的生產環境。部署前請以 `test -e /etc/systemd/system/ai-adm-d1.service` 確認。

**重啟服務**

```bash
# 重啟管理端服務
sudo systemctl restart ai-adm-d1

# 重啟學生端服務
sudo systemctl restart ai-stu-r1

# 確認服務狀態
sudo systemctl status ai-adm-d1 ai-stu-r1
```

服務配置檔案（`deploy/systemd/` 目錄實際內容）：
- `deploy/systemd/ai-adm-d1.service`
- `deploy/systemd/ai-stu-r1.service`
- `deploy/systemd/admin.env.example`
- `deploy/systemd/student.env.example`
- `deploy/systemd/b3-search-api.service`
- `deploy/systemd/b3-search.env.example`

#### 方式二：一鍵重啟腳本（開發/測試環境）

```bash
./reset-ai-smartbook.sh restart
```

支援的命令：
- `start`：啟動所有服務
- `stop`：停止所有服務
- `restart`：重啟所有服務
- `status`：檢查服務狀態
- `logs`：查看服務日誌

服務埠號：
- 管理端 API：`4300`
- 學生端 API：`4310`
- 管理端 Web：`5174`
- 學生端 Web：`5173`

### 2.3 Nginx 配置

**前置：安裝 Nginx 配置並建立備份（F4）**

首次部署或配置變更時，需先安裝 `deploy/nginx/*.conf` 並建立 `.backup`：

```bash
# 建立備份（若尚未備份）
sudo cp /etc/nginx/sites-available/ai-admin-r1.conf /etc/nginx/sites-available/ai-admin-r1.conf.backup 2>/dev/null || true
sudo cp /etc/nginx/sites-available/ai-stu-r1.conf /etc/nginx/sites-available/ai-stu-r1.conf.backup 2>/dev/null || true

# 安裝新配置
sudo cp deploy/nginx/ai-admin-r1.conf /etc/nginx/sites-available/ai-admin-r1.conf
sudo cp deploy/nginx/ai-stu-r1.conf /etc/nginx/sites-available/ai-stu-r1.conf

# 測試 Nginx 配置
sudo nginx -t

# 重新載入 Nginx
sudo systemctl reload nginx
```

> **環境限制**：本機無 `/etc/nginx` 目錄，此步驟僅適用於已安裝 Nginx 的生產環境。部署前請以 `test -e /etc/nginx` 確認。

Nginx 配置檔案（`deploy/nginx/` 目錄實際內容）：
- `deploy/nginx/ai-admin-r1.conf`（管理端反向代理）
- `deploy/nginx/ai-stu-r1.conf`（學生端反向代理）

### 2.4 發布後驗證

```bash
# Phase 2 HTTP Smoke 測試
pnpm smoke:phase2
```

此命令執行 `scripts/phase2-http-smoke.ts`，驗證：
- 公開 API：site-config、guest-ask、rate-limit
- 管理端 API：token 驗證、analytics、budget policies
- 回應安全掃描：無 secret/IP/stack 洩漏
- 資料庫記錄：request log、usage log、daily usage

## 3. 回滾觸發條件

當以下任一條件成立時，應立即啟動回滾流程：

| 觸發條件 | 嚴重程度 | 說明 |
|----------|----------|------|
| 發布門控出現 `FAIL` | 高 | 任何 gate 步驟失敗 |
| 資料庫遷移失敗 | 高 | schema 版本不一致或資料損壞 |
| 服務無法啟動 | 高 | systemd 服務反覆重啟 |
| Nginx 配置測試失敗 | 高 | `nginx -t` 回報錯誤 |
| 凭证解密失敗 | 高 | AI Provider 憑證無法使用 |
| 關鍵 API 返回 5xx | 高 | 健康檢查端點持續失敗 |
| 安全掃描發現洩漏 | 高 | 回應中包含 secret 或 stack trace |
| 效能明顯退化 | 中 | 回應時間超過閾值 |

## 4. 回滾步驟

### 4.1 立即停止新服務

```bash
# 方式一：systemd
sudo systemctl stop ai-adm-d1 ai-stu-r1

# 方式二：一鍵腳本
./reset-ai-smartbook.sh stop
```

### 4.2 恢復上一版本程式碼（F7）

> **⚠️ 警告**：`git reset --hard` 是破壞性指令，將**永久丟棄所有未提交的變更**。

```bash
# 步驟 1：記錄當前 SHA，以便需要時恢復
CURRENT_SHA=$(git rev-parse HEAD)
echo "Current SHA: $CURRENT_SHA"

# 步驟 2：確認目標 SHA 為已知穩定版（tag / release 紀錄）
git log --oneline -10
# 確認 <COMMIT_SHA> 對應已驗證的穩定版本

# 步驟 3：若有未提交的變更需保留，先處理
git status
# 若有重要未提交變更，先 git stash 或 commit

# 步驟 4：執行 reset
git reset --hard <COMMIT_SHA>

# 步驟 5：reset 後 lockfile 與 node_modules 可能不一致，需重跑安裝
corepack pnpm@9.15.0 install --frozen-lockfile
```

### 4.3 恢復資料庫（F3）

若資料庫已執行遷移，需手動恢復。實際資料庫路徑以 `packages/db/src/client.ts:41` 為準，預設為 `data/ai-smartbook-r1.db`（可透過 `$SQLITE_PATH` 環境變數覆蓋）。

**重要：SQLite WAL 模式一致性**

資料庫使用 WAL 模式（`journal_mode = WAL`），備份時需確保一致性：

1. **先停止服務**，確保無寫入操作進行中
2. 複製主檔 `ai-smartbook-r1.db` 以及配套的 `-wal` 和 `-shm` 檔案
3. 直接複製 WAL/SHM 檔案的安全性取決於當時無寫入操作；若無法確保，建議使用 `sqlite3 .backup` 工具（需實機驗證適用性）

```bash
# 設定資料庫路徑（預設值與 client.ts:41 一致）
SQLITE_PATH="${SQLITE_PATH:-data/ai-smartbook-r1.db}"

# 步驟 1：先停止服務，確保無寫入
sudo systemctl stop ai-adm-d1 ai-stu-r1
# 或
./reset-ai-smartbook.sh stop

# 步驟 2：備份當前資料庫（含 WAL/SHM 配套）
BACKUP_TS=$(date +%Y%m%d%H%M%S)
cp "$SQLITE_PATH" "${SQLITE_PATH}.backup.${BACKUP_TS}"
cp "${SQLITE_PATH}-wal" "${SQLITE_PATH}-wal.backup.${BACKUP_TS}" 2>/dev/null || true
cp "${SQLITE_PATH}-shm" "${SQLITE_PATH}-shm.backup.${BACKUP_TS}" 2>/dev/null || true

# 步驟 3：從備份恢復（若已有備份）
cp "${SQLITE_PATH}.backup.<TIMESTAMP>" "$SQLITE_PATH"
cp "${SQLITE_PATH}-wal.backup.<TIMESTAMP>" "${SQLITE_PATH}-wal" 2>/dev/null || true
cp "${SQLITE_PATH}-shm.backup.<TIMESTAMP>" "${SQLITE_PATH}-shm" 2>/dev/null || true
```

> **未知／需實機驗證**：`sqlite3 .backup` 工具在此環境的適用性尚未實機驗證；直接複製 WAL/SHM 的安全性假設服務已停止且無寫入，實際效果需實機確認。

### 4.4 恢復依賴

```bash
# 使用正確版本的 pnpm 重新安裝
corepack pnpm@9.15.0 install --frozen-lockfile
```

### 4.5 重建並重啟服務

```bash
# 重建
pnpm build

# 重啟服務
sudo systemctl restart ai-adm-d1 ai-stu-r1
# 或
./reset-ai-smartbook.sh restart
```

### 4.6 恢復 Nginx 配置（F4）

> **前置條件**：此步驟依賴 §2.3 中已建立的 `.backup` 檔案。若 §2.3 未執行（本機無 `/etc/nginx`），此步驟不適用。

```bash
# 確認備份存在
test -e /etc/nginx/sites-available/ai-admin-r1.conf.backup && echo "backup exists" || echo "NO BACKUP"
test -e /etc/nginx/sites-available/ai-stu-r1.conf.backup && echo "backup exists" || echo "NO BACKUP"

# 恢復上一版本 Nginx 配置
sudo cp /etc/nginx/sites-available/ai-admin-r1.conf.backup /etc/nginx/sites-available/ai-admin-r1.conf
sudo cp /etc/nginx/sites-available/ai-stu-r1.conf.backup /etc/nginx/sites-available/ai-stu-r1.conf

# 測試並重新載入
sudo nginx -t && sudo systemctl reload nginx
```

## 5. 事後驗證

### 5.1 服務健康檢查

```bash
# 確認服務運行
sudo systemctl status ai-adm-d1 ai-stu-r1

# 或
./reset-ai-smartbook.sh status
```

### 5.2 Smoke 測試

```bash
# Phase 2 HTTP Smoke
pnpm smoke:phase2

# 資料庫預檢
pnpm db:preflight:phase2
```

### 5.3 版本確認

```bash
# 確認當前版本
git log --oneline -1

# 確認 lockfile 完整性
sha256sum pnpm-lock.yaml
```

## 6. 環境變數清單

以下環境變數在發布過程中使用（密鍵值一律 [REDACTED]，見 Vault/環境變數）：

| 變數 | 用途 | 來源 |
|------|------|------|
| `ADMIN_API_TOKEN` | 管理端 API 認證 | [REDACTED]，見 Vault/環境變數 |
| `AI_CREDENTIAL_ENCRYPTION_KEY` | 凭证加密主金钥 | [REDACTED]，見 Vault/環境變數 |
| `AI_CREDENTIAL_OLD_KEY` | 凭证轮换旧金钥 | [REDACTED]，見 Vault/環境變數 |
| `AI_CREDENTIAL_NEW_KEY` | 凭证轮换新金钥 | [REDACTED]，見 Vault/環境變數 |
| `SQLITE_PATH` | 資料庫路徑 | 部署配置 |
| `PRODUCTION_BASE_URL` | 生產環境基礎 URL | 部署配置 |
| `PRODUCTION_ADMIN_BASE_URL` | 管理端生產 URL | 部署配置 |
| `PRODUCTION_STUDENT_BASE_URL` | 學生端生產 URL | 部署配置 |
| `STAGING_BASE_URL` | Staging 環境基礎 URL | 部署配置 |

## 7. 相關文件

- `docs/PHASE3A_PRODUCTION_VERIFICATION.md`：Phase 3A 生產環境驗證流程
- `scripts/phase3a-release-gate.mjs`：發布門控腳本
- `scripts/phase2-db-preflight.ts`：資料庫預檢腳本
- `scripts/phase2-http-smoke.ts`：Phase 2 HTTP Smoke 測試
- `scripts/credential-key-rotation.ts`：凭证轮换腳本
- `scripts/production-verification.mjs`：生產環境驗證腳本
- `scripts/release-gate-core.mjs`：門控核心邏輯
- `scripts/release-artifacts.mjs`：發布 artifact 工具
- `deploy/systemd/`：systemd 服務配置
- `deploy/nginx/`：Nginx 反向代理配置
- `reset-ai-smartbook.sh`：一鍵服務控制腳本
