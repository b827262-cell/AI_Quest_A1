# Codex 執行任務 — Phase 1: Synthetic Fixture, Safety Gate & Sites 架構驗證

> **文件狀態**：待執行 (Pending)  
> **目標規範**：[`docs/SITES_PHASE1_FIXTURE_SAFETY_SPEC.md`](file:///home/b827262/project/AI-Quest-A1/docs/SITES_PHASE1_FIXTURE_SAFETY_SPEC.md)  
> **分支建議**：`feat/sites-phase1-synthetic-fixtures-gate`  
> **報告語言**：繁體中文 (Traditional Chinese)  
> **執行重點**：自動化驗證、失敗即阻擋部署、禁止讀取 Production 資料庫與檔案  

---

## 1. 任務核心指令

請依據 [`docs/SITES_PHASE1_FIXTURE_SAFETY_SPEC.md`](file:///home/b827262/project/AI-Quest-A1/docs/SITES_PHASE1_FIXTURE_SAFETY_SPEC.md) 開始實作 Phase 1。

優先建立：
1. **Deterministic Synthetic Fixture Generator**（純程式合成）
2. **D1 Seed & R2 Seed**（注入腳本）
3. **Fixture Safety Scanner**（掃描器與來源驗證）
4. **Deployment Blocking Pipeline & Automated Tests**（自動化測試與阻擋閥門）

> **【硬性限制】**  
> 嚴禁任何程式碼連線、讀取或依賴任何 Production SQLite（例如 `/opt/.../*.db`、本機 production DB）、正式 filesystem user data、production `.env` 或正式 credentials。Generator 必須在程式結構上無法存取正式資料庫。

---

## 2. 具體交付檔案結構

在 `site/` 模組下實作以下結構：

```text
site/
├── fixtures/
│   ├── generate.ts                   # 100% 程式碼合成生成器
│   ├── seed-d1.ts                    # D1 種子資料注入腳本
│   ├── seed-r2.ts                    # R2 測試檔案注入腳本
│   ├── data/
│   │   ├── students.synthetic.json   # 假學生帳號資料
│   │   ├── books.synthetic.json      # 假書籍與章節資料
│   │   ├── progress.synthetic.json   # 假閱讀進度資料
│   │   └── rag.synthetic.json        # 假 RAG 測試文本
│   └── assets/
│       └── synthetic-test-book.pdf   # 測試專用 PDF
│
├── scripts/
│   ├── scan-fixture-safety.ts        # 掃描 fixture 是否含真實特徵
│   ├── scan-secrets.ts               # 掃描原始碼與 bundle 是否含金鑰
│   └── verify-no-production-data.ts  # 驗證生成來源與防 prod DB 連線
│
└── tests/
    ├── fixture-safety.spec.ts        # 10 項 Safety Gate 自動化測試
    ├── auth.spec.ts                  # ChatGPT Auth / 權限阻擋測試
    ├── d1.spec.ts                    # D1 CRUD 正確性
    ├── r2.spec.ts                    # R2 上傳、讀取、Range 請求
    ├── student.spec.ts               # 學生端端到端測試
    ├── admin.spec.ts                 # 管理端端到端測試
    ├── progress.spec.ts              # 閱讀進度儲存與同步
    └── rag.spec.ts                   # RAG 檢索問答流程
```

並在 `site/package.json` 加入對應 scripts：
```json
{
  "scripts": {
    "fixture:generate": "tsx fixtures/generate.ts",
    "fixture:seed:d1": "tsx fixtures/seed-d1.ts",
    "fixture:seed:r2": "tsx fixtures/seed-r2.ts",
    "fixture:safety": "tsx scripts/scan-fixture-safety.ts && tsx scripts/scan-secrets.ts && tsx scripts/verify-no-production-data.ts",
    "test:safety": "vitest run tests/fixture-safety.spec.ts",
    "test:access-control": "vitest run tests/auth.spec.ts",
    "test:d1": "vitest run tests/d1.spec.ts",
    "test:r2": "vitest run tests/r2.spec.ts",
    "test:e2e": "vitest run tests/student.spec.ts tests/admin.spec.ts tests/progress.spec.ts tests/rag.spec.ts"
  }
}
```

---

## 3. 必達 Safety Gate 檢查標準 (10/10)

交付成果必須執行自動化驗證，並在驗收報告中列出 10 項 PASS 狀態：

```text
Fixture Safety Gate (10/10)
──────────────────────────────────────────────────────────────────
[ ] 1. No production PII                  PASS
[ ] 2. No production credentials          PASS
[ ] 3. No production sessions             PASS
[ ] 4. No production chat logs            PASS
[ ] 5. No production IPs                  PASS
[ ] 6. No secrets in source               PASS
[ ] 7. No secrets in frontend bundle      PASS
[ ] 8. Access-control tests               PASS
[ ] 9. Fixture provenance = synthetic     PASS
[ ] 10. Production DB access = impossible  PASS
──────────────────────────────────────────────────────────────────
```

---

## 4. 驗收報告格式要求

完成任務後，請產出報告檔案 `docs/codex-reports/YYYY-MM-DD-sites-phase1-fixture-safety-report.md`，內容必須包含：

```text
# Sites Phase 1: Fixture Safety & Architecture Verification Report

## 1. Safety Gate 驗證結果
- Fixture Safety Gate: 10/10 PASS
- Provenance Check: PASS (全部資料源自 generate.ts 合成產生)
- DB Isolation Check: PASS (generator 無任何 prod DB 路徑或驅動引用)

## 2. 儲存層與服務驗證
- D1 Seed & CRUD: PASS
- R2 Seed & Streaming: PASS
- ChatGPT Auth & Access Control: PASS

## 3. 功能與 UI 對齊度
- Student Web E2E: PASS
- Admin Web E2E: PASS
- Reader & Progress: PASS
- RAG Pipeline: PASS
- UI Parity: [對齊百分比]%

## 4. 結論
Phase 1 Status: PASS (允許進入 Phase 2 正式教材遷移評估) / FAIL (保留於 Phase 1)
```
