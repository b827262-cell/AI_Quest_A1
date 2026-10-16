# scripts/a01-coverage — 72h 覆蓋等式彙整（草案）

讀取**脫敏**日誌彙總（JSON lines，欄位依 `relay.verify`：`evt,result,site,mode,identityPresent,method,pathClass,synthetic`，另含 `relay.probe`），輸出 72 小時驗收所需的計數與等式核對。

> 本工具為草案。門檻（300／100／30）與**覆蓋等式**皆為**提案，未經 Owner 確認**；輸出中一律標明。不含任何日誌原文／PII／secret。

## 輸出

- **自然／合成分列的 valid 計數**（依 `site`）——合成只補 30，**不計入** Student `>=300` / Admin `>=100`。
- **各 `pathClass` × `method` 計數**。
- **樣本門檻**：Student valid `>=300`、Admin valid `>=100`（僅自然樣本）。
- **每個適用非 GET 路徑 × 動詞 `>=30`**：日誌的 `pathClass` 無法區分路由模板，故此項需 `--route-counts` 輸入；未提供時標 `HOLD`，不推估。
- **零容忍項**：`result=invalid` 計數、`result=none AND identityPresent=true` 計數（皆須為 0）。
- **覆蓋等式（提案）**：`ingress 總量 = verify + probe 剝除 + health + books + sync + cors + static`，差值須為 0；所有分量由 `--ingress` 可設定輸入提供，未提供即 `HOLD`。

輸出檔：`docs/evidence/<runId>.coverage.json`（僅計數與固定標籤）。

## 使用

```bash
# 只讀日誌
node scripts/a01-coverage/index.mjs --logs logs.jsonl --out docs/evidence

# 加上逐路由與 ingress 輸入
node scripts/a01-coverage/index.mjs \
  --logs logs.jsonl \
  --route-counts routes.json \
  --ingress ingress.json \
  --student-min 300 --admin-min 100 --per-path-min 30
```

### 輸入格式

`--route-counts`（JSON）：

```json
{ "routes": [ { "site": "admin", "method": "POST", "pathTemplate": "/api/admin/books", "natural": 0, "synthetic": 30 } ] }
```

`--ingress`（JSON，全部為整數）：

```json
{ "ingressTotal": 100, "verify": 40, "probeStripped": 10, "health": 5, "books": 20, "sync": 5, "cors": 3, "static": 17 }
```

## 適用非 GET 路由（內建預設，依 runbook §4.3）

`PUT /api/student/progress`；`POST`、`DELETE /api/admin/books`；`POST /api/admin/books/upload`；`DELETE /api/admin/books/[id]`。

## 邊界

不部署、不碰 secret、不碰 migration 0003、不 force-push。

## 測試

```bash
node --test scripts/a01-coverage/core.test.mjs
```
