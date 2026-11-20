# Phase 3A Production Verification

> **版本**：1.1.0（R15 退件修正：F2／F6／F12）
> **對應基線**：HEAD `23b2d57`，branch `feat/front-back-integration-p1-p3`
> **最後更新**：2026-11-20

> **權限前提（F6）**：本章包含 `systemctl`、`nginx`、`cp /etc/nginx/…` 等需 **互動 sudo/root** 權限的操作。在非互動環境（`sudo -n` 要求密碼）下，這些步驟無法執行，請聯繫系統管理員。

> **註（F12）**：發布門控中的 `Rollback Procedure Available` 步驟為 `fileGate`（`phase3a-release-gate.mjs:44-53` 的 `existsSync`），**僅驗證三份檔案存在，不代表回滾流程已驗證可操作**。

## 1. 概述

本文檔記錄 Phase 3A 生產環境驗證流程，對應 `pnpm production:verify:phase3a` 命令（執行 `scripts/production-verification.mjs`）。

驗證範圍涵蓋：
- Nginx 反向代理配置驗證
- TLS 憑證有效性
- 學生端與管理端端點可達性
- 健康檢查端點
- 安全掃描（secret 洩漏檢測）
- 失敗時的處置與回滾銜接

## 2. 驗證前置條件

### 2.1 環境變數設定

執行生產驗證前，需設定以下環境變數：

| 變數 | 必填 | 說明 |
|------|------|------|
| `PRODUCTION_BASE_URL` | 是 | 生產環境基礎 URL（HTTPS） |
| `PRODUCTION_STUDENT_BASE_URL` | 是 | 學生端生產 URL（HTTPS） |
| `PRODUCTION_ADMIN_BASE_URL` | 是 | 管理端生產 URL（HTTPS） |
| `PRODUCTION_NGINX_BIN` | 否 | Nginx 執行檔路徑，預設 `nginx` |
| `PRODUCTION_NGINX_EFFECTIVE_CONFIG` | 否 | Nginx 有效配置快照路徑（`nginx -T` 輸出） |

### 2.2 服務狀態確認

```bash
# 確認服務運行中
sudo systemctl status ai-adm-d1 ai-stu-r1

# 確認 Nginx 運行中
sudo systemctl status nginx
```

### 2.3 網路連線確認

```bash
# 確認可到達生產端點
curl -sI "$PRODUCTION_STUDENT_BASE_URL"
curl -sI "$PRODUCTION_ADMIN_BASE_URL"
```

## 3. 驗證步驟

### 3.1 執行生產驗證

```bash
pnpm production:verify:phase3a
```

此命令執行 `scripts/production-verification.mjs`，自動執行以下檢查：

#### 3.1.1 Nginx 配置測試

- 執行 `nginx -t` 驗證配置語法
- 若 `PRODUCTION_NGINX_EFFECTIVE_CONFIG` 已設定，進一步檢查：
  - **永久 Admin token 注入**：確認反向代理不會注入或轉發非空的 Admin token 標頭
  - **Body size 和 AI timeout 指令**：確認 `client_max_body_size` 和 `proxy_read_timeout`/`proxy_send_timeout` 指令存在

#### 3.1.2 TLS 憑證驗證

- 對學生端和管理端分別執行 TLS 連線測試
- 驗證憑證有效性（過期檢查、CA 鏈驗證）
- 確認目標 URL 使用 HTTPS 協議

#### 3.1.3 端點可達性檢查

| 端點 | 路徑 | 期望狀態 |
|------|------|----------|
| 學生端首頁 | `/` | 200 |
| 公開 site-config | `/api/public/site-config` | 200 |
| 管理端健康檢查（live） | `/health/live` | 200 |
| 管理端健康檢查（ready） | `/health/ready` | 200 |

> **註（F2）**：`production-verification.mjs:175-211` 實際檢查的端點不含 `/api/admin/health`。管理端 API（`apps/AI-adm-D1/src`）僅有 `/health/live` 和 `/health/ready` 兩條健康檢查路由（見 `admin-api.integration.test.ts:442-443`）。`production-verification.mjs` 實際檢查的端點包括：學生端首頁、管理端首頁、Public site config、Student domain rejects Admin API、Admin unauthorized request、CORS origin rejection、Forwarded-header spoof、Security headers、Admin token protected API、Admin cookie flags、Uploads routing、Error responses sanitized。

#### 3.1.4 安全掃描

所有 HTTP 回應都會經過 secret 洩漏掃描，檢測以下模式：
- API key 模式（`sk-`、`AIza` 開頭）
- Authorization 標頭洩漏
- Admin token 洩漏
- Stack trace 洩漏
- 加密金钥指紋洩漏

### 3.2 驗證報告

執行後，驗證結果會寫入 artifact 檔案：

```
release-artifacts/production-verification.json
```

若設定 `PRODUCTION_REPORT_PATH` 環境變數，則寫入指定路徑。

報告格式：
```json
{
  "timestamp": "ISO 8601 時間戳",
  "checks": [
    {
      "name": "檢查名稱",
      "state": "PASS|FAIL|BLOCKED",
      "endpoint": "端點路徑",
      "status": 200,
      "ms": 123,
      "reason": "失敗原因（可選）"
    }
  ]
}
```

### 3.3 Staging Smoke 測試（輔助驗證）

在生產驗證前，建議先執行 Staging 環境的 Smoke 測試：

```bash
pnpm smoke:phase3a
```

此命令執行 `scripts/phase3a-staging-smoke.ts`，需要以下環境變數：

| 變數 | 說明 |
|------|------|
| `STAGING_BASE_URL` | Staging 環境基礎 URL |
| `STAGING_ADMIN_TOKEN` | 管理端 token（[REDACTED]，見 Vault/環境變數） |
| `PHASE3A_SMOKE_RUN_AI` | 設為 `true` 以執行 AI 請求測試 |
| `PHASE3A_SMOKE_RUN_LIMITS` | 設為 `true` 以執行 rate-limit 測試 |
| `PHASE3A_SMOKE_MUTATE` | 設為 `true` 以執行寫入操作測試 |

Staging smoke 涵蓋：
- 學生端前端可達性
- 公開 API：site-config、guest-ask
- AI 請求測試（需 `PHASE3A_SMOKE_RUN_AI=true`）
- Rate-limit 邊界測試（需 `PHASE3A_SMOKE_RUN_LIMITS=true`）
- 管理端 API：health、analytics、budget policies
- 回應安全掃描

## 4. 預期輸出

### 4.1 成功情況

```
[production-verification] nginx -t: PASS
[production-verification] Student TLS certificate: PASS
[production-verification] Admin TLS certificate: PASS
[production-verification] Student frontend: PASS (200, 123ms)
[production-verification] Public site config: PASS (200, 45ms)
[production-verification] Admin health: PASS (200, 67ms)
[production-verification] Secret scan: PASS
```

### 4.2 失敗情況

```
[production-verification] nginx -t: FAIL (configuration test failed)
[production-verification] Student TLS certificate: FAIL (certificate expired)
[production-verification] Student frontend: FAIL (expected 200, got 502)
[production-verification] Secret scan: FAIL (response contained unsafe internal material)
```

### 4.3 封鎖情況（BLOCKED）

```
[production-verification] nginx -t: BLOCKED (production target URLs are not configured)
[production-verification] Student TLS certificate: BLOCKED (target URL is not HTTPS)
```

## 5. 失敗處置

### 5.1 Nginx 配置失敗

```bash
# 查看配置錯誤詳情
sudo nginx -t

# 檢查配置檔案
sudo nginx -T | head -50

# 恢復備份配置
sudo cp /etc/nginx/sites-available/ai-admin-r1.conf.backup /etc/nginx/sites-available/ai-admin-r1.conf
sudo cp /etc/nginx/sites-available/ai-stu-r1.conf.backup /etc/nginx/sites-available/ai-stu-r1.conf
sudo nginx -t && sudo systemctl reload nginx
```

### 5.2 TLS 憑證問題

```bash
# 檢查憑證有效期
echo | openssl s_client -servername <HOSTNAME> -connect <HOSTNAME>:443 2>/dev/null | openssl x509 -noout -dates

# 若憑證即將過期，重新申請
# （使用 Let's Encrypt 或其他 CA）
```

### 5.3 端點不可達

```bash
# 檢查服務狀態
sudo systemctl status ai-adm-d1 ai-stu-r1

# 檢查埠監聽
ss -tlnp | grep -E '4300|4310'

# 重啟服務
sudo systemctl restart ai-adm-d1 ai-stu-r1
```

### 5.4 安全掃描失敗

當回應中包含 secret 或 stack trace 時：
1. 立即記錄失敗的端點和回應內容
2. 檢查對應的 API 路由是否有洩漏
3. 確認 `scripts/production-verification.mjs` 中的 `safeBody()` 函數檢測到的模式
4. 修復後重新執行驗證

## 6. 與回滾流程銜接

當生產驗證失敗時，依以下流程銜接回滾：

### 6.1 判斷嚴重程度

| 驗證項目 | 失敗時 | 處置 |
|----------|--------|------|
| nginx -t | 配置錯誤 | 修復配置或恢復備份 |
| TLS 憑證 | 憑證無效 | 緊急更換憑證 |
| 端點不可達 | 服務中斷 | 重啟服務或回滾 |
| 安全掃描 | 資料洩漏 | **立即回滾** |

### 6.2 回滾執行

參考 `docs/PHASE2_RELEASE_RUNBOOK.md` §4 回滾步驟：

1. 停止新服務
2. 恢復上一版本程式碼
3. 恢復資料庫（若需要）
4. 恢復依賴
5. 重建並重啟服務
6. 恢復 Nginx 配置

### 6.3 回滾後再驗證

```bash
# 回滾完成後重新執行生產驗證
pnpm production:verify:phase3a

# 確認所有檢查通過
# 檢查 artifact 報告
cat release-artifacts/production-verification.json
```

## 7. 發布門控中的生產驗證

在完整發布門控（`scripts/phase3a-release-gate.mjs`）中，生產驗證是其中一個 gate 步驟：

```
pnpm release-gate:phase3a
```

門控中的生產驗證步驟：
- 執行 `pnpm production:verify:phase3a`
- 根據 exit code 判定狀態：
  - `0` → `PASS`
  - `2` → `BLOCKED`
  - 其他 → `FAIL`

生產驗證 gate 的狀態會影響整體門控結果：
- 任一 gate 為 `FAIL` → 整體 `FAIL`
- 無 `FAIL` 但有 `BLOCKED` → 整體 `BLOCKED`
- 全部 `PASS` → 整體 `PASS`

## 8. 相關文件

- `docs/PHASE2_RELEASE_RUNBOOK.md`：Phase 2 發布與回滾操作手冊
- `scripts/production-verification.mjs`：生產環境驗證腳本
- `scripts/phase3a-staging-smoke.ts`：Staging 環境 Smoke 測試
- `scripts/phase2-http-smoke.ts`：Phase 2 HTTP Smoke 測試
- `scripts/phase3a-release-gate.mjs`：發布門控腳本
- `scripts/release-gate-core.mjs`：門控核心邏輯
- `scripts/release-artifacts.mjs`：發布 artifact 工具
- `deploy/nginx/ai-admin-r1.conf`：管理端 Nginx 配置
- `deploy/nginx/ai-stu-r1.conf`：學生端 Nginx 配置
- `deploy/systemd/ai-adm-d1.service`：管理端 systemd 服務
- `deploy/systemd/ai-stu-r1.service`：學生端 systemd 服務
