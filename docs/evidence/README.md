# docs/evidence — 驗收證據輸出目錄

此目錄存放 A-01 72 小時驗收期間由腳本產生的**脫敏**證據檔。為避免誤提交，除本檔與 `.gitignore` 外，所有內容皆被忽略；證據本身由維運保存於平台側，不進版控。

## 產出者與檔名

| 腳本 | 檔名 | 內容 |
| --- | --- | --- |
| `scripts/a01-synthetic/index.mjs` | `<runId>.summary.json` | 注入彙總：目標主機、逐路徑筆數、停止原因。 |
| `scripts/a01-synthetic/index.mjs` | `<runId>.manifest.json` | 本次送出的目標矩陣與清理步驟。 |
| `scripts/a01-coverage/index.mjs` | `<runId>.coverage.json` | 覆蓋等式與 300／100／30 計數彙總。 |

## 格式契約（所有 evidence 檔）

- 頂層必含 `kind`（如 `a01-synthetic-summary`）、`runId`、`generatedAt`。
- **禁止**任何原始請求／回應內容、憑證、secret、token、原始使用者 ID 或未遮罩 IP。
- IP 一律遮罩（IPv4 → `/16`，IPv6 → `/48`）；ID 一律雜湊（含每次執行 salt）。
- 提案性質的門檻（如覆蓋等式、300／100／30）必須在輸出中標明「提案，未經 Owner 確認」。
