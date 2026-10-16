# scripts/a01-synthetic — A-01 合成流量注入（僅 staging）

用於 72 小時驗收窗口的合成流量注入器：對 relay 受保護的「路徑 × 動詞」矩陣送出**已簽章**的合成請求，讓每個適用的非 GET 路徑／動詞達到 `>=30` 的建議下限，並在 `relay.verify` 日誌以 `synthetic: true` 標記。合成樣本**只補 30**，**不計入** Student `>=300` / Admin `>=100` 的自然樣本門檻。

> 本工具為草案，僅供 staging 使用。不部署、不連 production、不在撰寫期讀取任何實際 secret、不碰 migration 0003、不 force-push。

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `index.mjs` | CLI：前置驗證、注入、停止判斷、輸出 evidence。 |
| `core.mjs` | 純函式：目標守門、脫敏、停止條件、覆蓋展開。 |
| `targets.mjs` | 路徑 × 動詞矩陣（依 `docs/ops/relay-rollout.md` §4.3）。 |
| `signer.mjs` | 標準 relay 簽章鏡像（`a01-relay-v1`，HMAC-SHA256，base64url）。 |
| `core.test.mjs` / `signer.test.mjs` | 單元測試。 |

## 安全護欄

1. **僅 staging。** 目標 base URL 由 `A01_SYNTHETIC_BASE_URL` 提供；主機必須同時在 `A01_SYNTHETIC_ALLOWED_HOSTS` 白名單內、且**不**符合 production 後綴（預設 `.chatgpt.site`）。未設定或落在 production 一律拒絕執行。
2. **憑證只從執行期環境變數讀取。** 腳本不列印任何環境變數值，輸出前以 `assertNoSecrets` 檢查，確保彙總／manifest 不含任何 secret。
3. **覆蓋矩陣。** 每個適用的非 GET 路徑／動詞與 GET（Owner 18:00 決議含 GET）皆納入；每路徑目標筆數預設 30，速率上限可設定。
4. **停止條件。** 錯誤率／5xx 比例超閾值，或存在手動 stop 檔即停止；並記錄清理步驟。
5. **輸出脫敏。** 僅寫出彙總與 manifest（IP 遮罩、ID 雜湊、無原始請求內容）至 `docs/evidence/`。
6. **預設 dry-run。** 預設為 dry-run 模式（亦可明確帶 `--dry-run`），只驗證設定並列印計畫，不發任何網路請求。必須明確指定 `--execute` 且同時具備必要環境變數（如 `A01_SYNTHETIC_BOOK_ID` 等）才會發出實際網路請求。

## 使用

```bash
# 預設預覽（預設 dry-run，不發請求）
A01_SYNTHETIC_BASE_URL=https://<staging-host> \
A01_SYNTHETIC_ALLOWED_HOSTS=<staging-host> \
node scripts/a01-synthetic/index.mjs --per-target 30 --rate 5

# 或明確帶 --dry-run
node scripts/a01-synthetic/index.mjs --dry-run

# 實際注入（必須明確帶 --execute 並具備必要環境變數）
A01_SYNTHETIC_BASE_URL=https://<staging-host> \
A01_SYNTHETIC_ALLOWED_HOSTS=<staging-host> \
A01_SYNTHETIC_STUDENT_RELAY_KEY=*** A01_SYNTHETIC_ADMIN_RELAY_KEY=*** \
A01_SYNTHETIC_BOOK_ID=<test-book-id> \
A01_SYNTHETIC_ERROR_RATE_LIMIT=0.05 A01_SYNTHETIC_5XX_RATE_LIMIT=0.02 \
node scripts/a01-synthetic/index.mjs --execute --per-target 30 --rate 5 --stop-file /tmp/a01-synthetic.stop

# 清理（視窗結束後）
node scripts/a01-synthetic/index.mjs --cleanup
```

### 環境變數

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `A01_SYNTHETIC_BASE_URL` | 是 | staging origin（https）。 |
| `A01_SYNTHETIC_ALLOWED_HOSTS` | 是 | 逗號分隔的 staging 主機白名單（拒絕預設）。 |
| `A01_SYNTHETIC_PRODUCTION_SUFFIXES` | 否 | 覆寫 production 後綴，預設 `.chatgpt.site`。 |
| `A01_SYNTHETIC_STUDENT_*` / `A01_SYNTHETIC_ADMIN_*` | 否 | `_USER_ID` / `_EMAIL` / `_RELAY_KEY` 身分與簽章金鑰。 |
| `A01_SYNTHETIC_BOOK_ID` | 是（--execute 時） | `[id]` 路由的測試資料 id。 |
| `A01_SYNTHETIC_ERROR_RATE_LIMIT` / `A01_SYNTHETIC_5XX_RATE_LIMIT` | 否 | 0..1 比例，`0` 停用該檢查。 |
| `A01_SYNTHETIC_CLEANUP_ACCOUNT_PATH` | 否 | 停用測試帳號的 POST 路徑。 |
| `A01_SYNTHETIC_RUN_ID` | 否 | 覆寫 run id。 |

## 清理

manifest 記錄三種清理步驟：刪除測試資料（`--cleanup` 執行）、停用測試帳號（`--cleanup` 執行，需 `A01_SYNTHETIC_CLEANUP_ACCOUNT_PATH`）、視窗結束後由維運移除 `A01_SYNTHETIC_ACCOUNTS` 白名單項目（人工）。

## 測試

```bash
node --test scripts/a01-synthetic/core.test.mjs scripts/a01-synthetic/signer.test.mjs
```

`signer.test.mjs` 內含以 `site/lib/relay-signature.ts` 產生的已知向量，並在其可匯入時做交叉比對。
