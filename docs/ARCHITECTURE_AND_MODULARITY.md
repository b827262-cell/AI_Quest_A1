# AI_Quest_A1 程式結構與模組化原則

## 1. 文件目的

本文件定義 `AI_Quest_A1` 的正式程式結構、模組邊界、依賴方向、命名規則與驗收標準。

本專案可沿用 `AI-SmartBook-R1` 已驗證的 Monorepo 經驗，但不得直接複製舊專案的耦合、歷史命名或 runtime 假設。所有新功能應先判斷歸屬，再進入正確模組。

核心目標：

1. 前端、後端、領域邏輯、資料存取與 AI Provider 明確分層。
2. 共用能力只能透過公開入口匯入，禁止跨目錄讀取內部檔案。
3. Browser 與 Server 程式碼物理隔離，避免 Node.js 模組進入前端 bundle。
4. Schema、Domain、Repository、Service、Route 各自只負責單一層級。
5. 新模組可獨立測試、替換與部署，不依賴隱藏全域狀態。

---

## 2. 建議 Monorepo 結構

```text
AI_Quest_A1/
├── apps/
│   ├── student-web/              # 學生端 React/Vite SPA
│   ├── admin-web/                # 管理端 React/Vite SPA
│   ├── student-api/              # 學生端 API / BFF
│   └── admin-api/                # 管理端 API / 管理工作流
│
├── packages/
│   ├── ai-gateway/               # Provider adapter、routing、fallback
│   ├── ai-orchestration/         # 多模型任務拆解、並行、融合與裁決
│   ├── quest-core/               # 題目、作答、評分、解析等核心領域
│   ├── book-core/                # PDF、章節、內容擷取與索引
│   ├── auth/                     # 身分驗證、授權、session/token
│   ├── db/                       # schema、migration、repository
│   ├── contracts/                # API DTO、Zod schema、共享型別
│   ├── ui/                       # 純瀏覽器共用 UI 元件
│   ├── observability/            # log、metrics、trace、audit contract
│   ├── config/                   # 可驗證的環境與應用設定
│   └── test-utils/               # 測試 fixture、builder、mock adapter
│
├── scripts/                      # migration、smoke、release gate
├── docs/                         # 架構、ADR、維運與驗收文件
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.base.json
```

若目前專案仍維持 `AI-Stu-R1`、`AI-adm-D1` 等舊名稱，可以分階段調整；但新增程式應遵守本文件的邊界，不再擴大舊命名依賴。

---

## 3. 各層責任

### 3.1 Apps 層

Apps 是組裝層，不是共用邏輯存放處。

Apps 可以負責：

- Route、Controller、Page、Layout。
- 依賴注入與應用啟動。
- 將 HTTP、UI event 轉換為 application command。
- 組裝 packages 提供的能力。

Apps 不得負責：

- 跨頁共用的領域規則。
- SQL 查詢與 migration。
- Provider SDK 細節。
- 可被其他 app 重用的核心流程。

### 3.2 Core Domain 層

`quest-core`、`book-core` 等核心套件保存穩定領域規則。

原則：

- 不依賴 React、Express/Hono、SQLite、Provider SDK。
- 輸入輸出使用 domain type 或 contracts。
- 時間、亂數、ID、外部服務以 interface 注入。
- 狀態轉移必須集中管理，不得散落在 route 或 UI。

### 3.3 Contracts 層

`contracts` 是跨 app、跨 package 的資料契約中心。

包含：

- Zod request/response schema。
- API DTO。
- Event payload。
- 公開 enum 與 error code。

不得包含：

- DB row 型別。
- React component props。
- Provider SDK 原始 response。
- 含 secret 的內部型別。

### 3.4 DB 層

`db` 只負責資料持久化與交易完整性。

建議結構：

```text
packages/db/src/
├── schema/
├── migrations/
├── repositories/
├── transactions/
├── seeds/
├── client.ts
├── browser.ts        # 通常不存在或只提供安全型別
└── server.ts         # DB 公開 server 入口
```

規則：

- Route 不得直接寫 SQL。
- Repository 不得包含 HTTP response 或 UI 文案。
- Migration 必須可重跑、可驗證，並有 backfill 策略。
- 多表更新或額度異動必須放在單一 transaction。
- Runtime DB、`.env`、API key、log dump 不得進 Git。

### 3.5 AI Gateway 層

`ai-gateway` 處理單次模型呼叫與 Provider 差異。

包含：

- Provider adapter。
- Credential selection。
- Model mapping。
- Timeout、retry、cooldown、fallback。
- Usage normalization。

不包含：

- 題目教學策略。
- 多模型答案融合。
- UI 呈現格式。
- DB migration。

### 3.6 AI Orchestration 層

`ai-orchestration` 負責高階任務流程，例如：

1. 接收並分類使用者問題。
2. 建立標準化任務與上下文。
3. 分派給 ZAI、Gemini、OpenAI 等模型。
4. 驗證答案完整性與一致性。
5. 必要時進行第二模型覆核。
6. 融合成可呈現答案。

此層只能依賴 `ai-gateway` 的公開 interface，不得直接使用 Provider SDK。

---

## 4. 強制依賴方向

允許的主要方向：

```text
apps
  ↓
ai-orchestration / application services
  ↓
quest-core / book-core / auth
  ↓
contracts and interfaces

server apps
  ↓
db / ai-gateway / observability adapters
```

禁止：

- `packages/*` 反向依賴 `apps/*`。
- Domain core 依賴 DB、HTTP framework 或 React。
- UI 套件匯入 server-only 模組。
- DB repository 匯入 route/controller。
- `ai-gateway` 匯入學生頁面或題庫 UI。
- 以相對路徑跨 package 深層匯入。

錯誤示例：

```ts
import { createHmac } from "../../../packages/ai/src/server/ip-hash";
```

正確示例：

```ts
import { hashVisitorIp } from "@ai-quest/ai-gateway/server";
```

---

## 5. Browser / Server 邊界

每個可能同時被前後端使用的 package，必須明確提供入口：

```text
src/
├── browser.ts
├── server.ts
├── shared.ts
└── internal/
```

`package.json` 建議：

```json
{
  "exports": {
    "./browser": "./src/browser.ts",
    "./server": "./src/server.ts",
    "./shared": "./src/shared.ts"
  }
}
```

規則：

- Browser entry 禁止匯入 `node:*`、DB client、filesystem、crypto secret helper。
- Server entry 可以依賴 Node.js 能力，但不可被 SPA 使用。
- 不建立會同時導出 browser/server 內容的模糊 barrel `index.ts`。
- CI 必須執行 browser bundle 檢查，避免 server import chain 造成白屏。

---

## 6. 模組內部標準結構

一個具完整行為的模組建議如下：

```text
feature-name/
├── domain/
│   ├── entities.ts
│   ├── value-objects.ts
│   ├── errors.ts
│   └── state-machine.ts
├── application/
│   ├── commands.ts
│   ├── queries.ts
│   └── service.ts
├── ports/
│   ├── repository.ts
│   └── provider.ts
├── adapters/
│   ├── db-repository.ts
│   └── provider-adapter.ts
├── schemas/
├── tests/
├── browser.ts
└── server.ts
```

小型模組不需為了形式建立空目錄，但責任仍需分離。

---

## 7. 命名原則

### Package

使用一致 scope：

```text
@ai-quest/contracts
@ai-quest/db
@ai-quest/quest-core
@ai-quest/ai-gateway
@ai-quest/ai-orchestration
@ai-quest/ui
```

### 檔案

- React component：`PascalCase.tsx`
- Hook：`useSomething.ts`
- Service：`something.service.ts`
- Repository：`something.repo.ts`
- Schema：`something.schema.ts`
- Test：`something.test.ts`
- Server-only：放入 `server/` 或由 `server.ts` 輸出

### API 與錯誤碼

- URL 使用名詞與小寫 kebab-case。
- Error code 使用穩定機器碼，例如 `QUEST_NOT_FOUND`。
- UI 文案不得作為程式判斷條件。
- Provider 原始錯誤不得直接回傳給前端。

---

## 8. Public API 原則

每個 package 都必須列出最小公開面。

公開：

- 穩定 interface。
- DTO/schema。
- Factory 或 service entry。
- 明確 browser/server API。

內部：

- SQL helper。
- Provider response mapper。
- Secret handling。
- 私有 state mutation helper。
- 只供單一 adapter 使用的型別。

禁止其他 package 匯入 `src/internal/*`、`src/repositories/*` 等深層路徑。

---

## 9. 設定與秘密資料

- 所有環境變數由 `@ai-quest/config/server` 集中解析。
- 使用 Zod 驗證，production 缺少必要 secret 時 fail closed。
- API key 只能在 server runtime 存取。
- 回應、audit log、exception、test snapshot 均不得包含 key material。
- 前端只能取得遮罩狀態與非敏感 metadata。
- `.env.example` 僅列變數名稱與說明，不放真實值。

---

## 10. 測試分層

每個模組至少具備：

1. Unit test：domain rule、state machine、schema。
2. Integration test：repository、transaction、adapter。
3. Contract test：API request/response 與 error code。
4. Smoke test：應用可啟動、核心 endpoint 可用。
5. Build test：browser bundle 不含 server-only dependency。

測試禁止：

- 硬編 clone 絕對路徑。
- 依賴開發者真實 `.env`。
- 使用真實 API key 作為一般 CI 前提。
- 因資料夾名稱不同就失敗。

---

## 11. 新功能放置判斷

新增功能前依序回答：

1. 這是 UI、HTTP、流程、領域規則、資料存取或外部 adapter？
2. 是否會被兩個以上 app 使用？
3. 是否需要 browser 與 server 共同使用？
4. 是否包含 secret、filesystem、DB 或 Provider SDK？
5. 能否以 interface 隔離外部依賴？

判斷範例：

- 題目難度與作答狀態規則 → `quest-core`
- AI Provider HTTP 呼叫 → `ai-gateway`
- ZAI + Gemini 解題與融合 → `ai-orchestration`
- SQLite 題目查詢 → `db/repositories`
- 學生答題畫面 → `student-web`
- 管理員題庫 API → `admin-api`
- 共用 request schema → `contracts`

---

## 12. 遷移自 AI-SmartBook-R1 的原則

允許移植：

- 已驗證的 domain rule。
- 通用 Zod schema。
- Provider adapter interface。
- 安全 credential、quota、reservation 概念。
- 可獨立測試的 UI 元件。

禁止整包複製：

- 舊 app 內混合 route、DB、domain 的大型檔案。
- 含舊專案名稱的路徑與 package name。
- 依賴特定 clone 路徑的測試。
- 真實 `.env`、DB、log、uploads。
- 未分離的 browser/server barrel。
- 舊的暫時 fallback、mock 或 Pilot-only 欄位。

每次移植應建立 mapping：

| 舊位置 | 新位置 | 是否重構 | 驗證方式 |
|---|---|---:|---|
| 舊功能檔案 | 新 package/module | 是/否 | unit/integration/build |

---

## 13. 第一階段落地順序

### Phase A：基礎骨架

- 確認 pnpm workspace。
- 建立 `tsconfig.base.json`。
- 統一 `@ai-quest/*` package scope。
- 建立 browser/server export convention。
- 建立 lint、typecheck、test、build 根命令。

### Phase B：核心契約

- 建立 `contracts`。
- 建立 `quest-core`。
- 建立 DB repository interface。
- 定義穩定 error code。

### Phase C：AI 能力

- 建立 `ai-gateway` provider ports/adapters。
- 建立 `ai-orchestration`。
- 加入 timeout、retry、fallback、usage 與 audit。

### Phase D：Apps 組裝

- 學生端與管理端分離。
- API 與 UI 不共用 server implementation。
- 透過公開 package entry 組裝功能。

---

## 14. Pull Request 驗收清單

每個 PR 必須確認：

- [ ] 新程式放在正確層級。
- [ ] 沒有新增跨 package 深層 import。
- [ ] 沒有 browser → server dependency。
- [ ] 沒有 route 直接 SQL。
- [ ] 沒有 domain 依賴 framework。
- [ ] 沒有 secret 或 runtime data 進 Git。
- [ ] 公開 API 有 schema/type。
- [ ] state mutation 有測試。
- [ ] typecheck 通過。
- [ ] test 通過。
- [ ] build 通過。
- [ ] migration 與 backfill 可驗證。
- [ ] README 或 docs 已同步。

---

## 15. Definition of Done

`AI_Quest_A1` 的模組化基礎完成，至少需達到：

1. 所有 workspace package 可獨立 typecheck。
2. Apps 只透過公開 exports 使用 packages。
3. Browser bundle 不含 Node.js server 模組。
4. Domain 核心可在無 DB、無 HTTP server 下測試。
5. Provider 可替換而不修改題目核心。
6. DB 可替換或測試而不修改 route contract。
7. 根目錄可一次執行 install、typecheck、test、build。
8. 架構文件、README 與實際目錄一致。

本文件為新功能與程式移植的預設規範。任何偏離應以 ADR 說明原因、影響與退出策略。
