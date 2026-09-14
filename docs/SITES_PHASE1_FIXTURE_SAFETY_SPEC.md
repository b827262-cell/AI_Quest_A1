# Sites 遷移 Phase 1：Sanitized Fixture 安全基線與自動化 Safety Gate 規範

## 1. 核心安全定位與認知

> **「因為 Phase 1 使用的是 sanitized 測試資料，所以正式個資外洩風險大幅降低；但仍不能視為完全沒有安全性問題。」**

### 1.1 平台特性與限制
根據 OpenAI 官方說明，ChatGPT Sites 在現階段**不支援 Data Residency / Inference Residency**，其範圍包含：
- Site 原始碼與靜態資源
- Cloudflare D1 資料庫與 R2 儲存物件
- 生成的 Artifacts
- 執行時期 Logs 與 Telemetry

### 1.2 Phase 1 的定位
Phase 1 的核心定位為**「架構與功能實驗環境」**，驗證 E500 版本能否以 Sites 架構（Worker + D1 + R2）實現 1:1 UI parity 與完整功能對齊。在此階段，必須徹底切斷與正式環境機敏資料的任何連結。

---

## 2. 實作架構：四個可執行層級

本規範不僅是文字宣示，更必須轉化為**可自動驗證、失敗即阻擋部署**的工程流水線：

```text
SITES_PHASE1_FIXTURE_SAFETY_SPEC.md
              │
              ▼
      1. Fixture Generator (純程式合成、無連線 Production DB 能力)
              │
              ▼
      2. Safety Scanner (掃描 PII / 憑證 / Secrets / Provenance)
              │
              ▼
      3. Automated Tests (D1 / R2 / Access Control / E2E)
              │
              ▼
      4. Deployment Gate (任一失敗即 DO NOT DEPLOY)
```

### 2.1 目錄與檔案規範

```text
site/
├── fixtures/
│   ├── generate.ts                   # 100% 程式碼合成生成器 (Deterministic / Faker)
│   ├── seed-d1.ts                    # D1 種子資料注入腳本
│   ├── seed-r2.ts                    # R2 測試檔案注入腳本
│   ├── data/
│   │   ├── students.synthetic.json   # 合成學生資料
│   │   ├── books.synthetic.json      # 合成書籍與章節
│   │   ├── progress.synthetic.json   # 合成閱讀進度
│   │   └── rag.synthetic.json        # 合成 RAG 測試文本
│   └── assets/
│       └── synthetic-test-book.pdf   # 合成測試 PDF
│
├── scripts/
│   ├── scan-fixture-safety.ts        # 掃描 fixture 是否含真實特徵
│   ├── scan-secrets.ts               # 掃描原始碼與 bundle 是否含金鑰
│   └── verify-no-production-data.ts  # 驗證生成來源與防 production DB 連線
│
└── tests/
    ├── fixture-safety.spec.ts        # Safety Gate 自動化測試
    ├── auth.spec.ts                  # ChatGPT Auth / 未授權阻擋
    ├── d1.spec.ts                    # D1 CRUD 正確性
    ├── r2.spec.ts                    # R2 上傳、讀取、Range 請求
    ├── student.spec.ts               # 學生端端到端測試
    ├── admin.spec.ts                 # 管理端端到端測試
    ├── progress.spec.ts              # 閱讀進度儲存與同步
    └── rag.spec.ts                   # RAG 檢索問答流程
```

### 2.2 部署阻擋流水線 (Deployment Blocking Pipeline)

在 Sites 進行預覽或發布前，必須循序執行下列指令：

```bash
npm run fixture:generate
npm run fixture:safety
npm run test:access-control
npm run test:d1
npm run test:r2
npm run test:e2e
npm run build
```

**原則：任一步驟失敗，即刻中斷（DO NOT DEPLOY）。**

---

## 3. Fixture Safety Gate (10 項硬指標)

所有檢查項必須全數達到 `PASS`：

```text
Fixture Safety Gate (10/10)
──────────────────────────────────────────────────────────────────
[ ] 1. No production PII                  PASS (無真實姓名、Email、個資)
[ ] 2. No production credentials          PASS (無密碼雜湊、Auth secrets)
[ ] 3. No production sessions             PASS (無正式 session 記錄)
[ ] 4. No production chat logs            PASS (無歷史對話紀錄)
[ ] 5. No production IPs                  PASS (無真實使用者 IP 歷史)
[ ] 6. No secrets in source               PASS (無 .env、API keys、私鑰)
[ ] 7. No secrets in frontend bundle      PASS (client bundle 無機敏常數)
[ ] 8. Access-control tests               PASS (未授權 API 攔截、角色隔離)
[ ] 9. Fixture provenance = synthetic     PASS (每筆資料均由 generator 生產)
[ ] 10. Production DB access = impossible  PASS (代碼無 prod DB 路徑與連線能力)
──────────────────────────────────────────────────────────────────
```

### 3.1 關鍵防護定義：
- **項目 9 (Fixture provenance = synthetic)**：每一筆 fixture 必須具備可追溯之合成標記或生成驗證碼，證明是由 Generator 產生，嚴禁人工手動複製貼上。
- **項目 10 (Production DB access = impossible)**：Fixture Generator 在物理層級與程式碼層級**無能力連接 Production SQLite**。不接受 Production DB 路徑參數、不讀取 `/opt/.../*.db`、不引用正式環境變數。

---

## 4. Phase 1 Acceptance Gate (E500 vs Sites 1:1 驗收)

完成 Safety Gate 後，執行架構與功能對齊驗收：

```text
Phase 1 Acceptance Gate
──────────────────────────────────────────────────────────────────
Architecture
[ ] Worker/API 正常響應
[ ] D1 CRUD 狀態一致
[ ] R2 upload / read / range 串流支援
[ ] Secrets 與配置完全隔離

Student Experience
[ ] Login / ChatGPT Auth 流程
[ ] Library 書架瀏覽
[ ] Reader 閱讀器與字體排版
[ ] Progress 進度即時保存
[ ] RAG 提問與上下文串接

Admin Operations
[ ] Login / 權限檢查
[ ] Books 教材管理 CRUD
[ ] Students 測試名單檢視
[ ] Content 內容與章節管理
[ ] Permissions 越權阻擋

Parity (E500 vs Sites)
[ ] Routes 路由對應
[ ] API Contracts 介面對齊
[ ] UI 截圖 / Layout 對齊
[ ] Responsive 行動與桌面體驗
[ ] Error States 錯誤處理與提示

Security
[ ] Fixture Safety Gate 10/10 全數 PASS
[ ] Unauthorized access denied (401/403)
[ ] Student / Admin 嚴格權限隔離
[ ] No secret leakage in telemetry / logs

Result
──────────────────────────────────────────────────────────────────
全數通過 (PASS) ──► 啟動 Phase 2 正式教材遷移評估
任一失敗 (FAIL) ──► 保留於 Phase 1，持續修正
```

---

## 5. Phase 2 啟動前提與法規責任

當 Phase 1 的 10 項 Safety Gate 與 Acceptance Gate 全數 PASS 後，方可進入 Phase 2：
1. **重啟 Data Classification & Privacy Review**：
   - 僅限教材內容（書籍、章節、PDF、附件、RAG metadata/index）。
   - 永久排除真實使用者資料、Session、IP、對話紀錄與金鑰。
2. **End User Data 保護責任**：
   - 根據 OpenAI 規範，Site 擁有者須對 Site 收集的 End User Data 及相應資料保護義務負責。
   - 正式營運前須配置符合法律要求之隱私權宣告與存取政策。
