# Windows Google AI 問答接力模擬器操作指南

> **版本**：1.0.0（R16-T5）
> **對應基線**：HEAD `077301f`，branch `feat/front-back-integration-p1-p3`
> **最後更新**：2026-11-21
> **狀態**：設計規格文件；R16-T4 實作進行中

## 1. 現況與痛點

目前 Windows 學員在使用「搜尋好朋友／谷哥」（`strategy: "google-ai"`）時存在以下斷點：

### 1.1 全螢幕新分頁迷航

`useGuestQuestion.ts:233` 使用 `window.open(googleAiSearchUrl(trimmed), "_blank", "noopener,noreferrer")` 直接開啟新分頁並清空輸入框。學員切回原分頁時，畫面沒有彈出對應當前題目的接收視窗，必須自己往下滾動到 `LearningHistoryPanel` 尋找剛才的題目。

### 1.2 剪貼簿權限攔截

`LearningHistoryPanel.tsx:61` 依賴 `navigator.clipboard.readText()`（透過 `readClipboardText()` 呼叫）。在 Windows Chrome／Edge 中會跳出剪貼簿讀取權限詢問；學員一旦忽略、誤按封鎖或焦點不在頁面，就會進入 catch 錯誤（「無法讀取剪貼簿；請允許權限，或展開下方手動貼上備援」），被迫點「修改 → 貼上 → 儲存」共 4 步才能完成。

### 1.3 67% 詞彙重疊門檻誤擋

`useShareIntake.ts:108` 即使學員已在特定題目按下「從剪貼簿帶回回答」（傳入 `preferredEntry`），仍強制要求 `canAutoBindAnswer(binding)`（回答必須包含題目 67% 以上雙字詞 token，`learningHistory.ts:485`）。若 Google AI 回答換句話說或題目較短，系統會拒絕直接存入，又跳出「這份回覆要對應哪一題？」要求二次確認。

### 1.4 網址／內文分離失誤

手機端可透過 PWA Share Target 一次帶入 `text + url`；Windows 學員若點 Google 的「分享連結」只會複製到 URL（被 `isUrlOnlyText` 拒絕），若反白複製文字又缺 `sourceUrl`。

## 2. 解決方案：接力模擬器（Relay Simulator）

### 2.1 左右並排彈窗取代盲開分頁

在 Windows 桌面環境點擊「送出（搜尋好朋友／谷哥）」時：

- **螢幕右側**以受控尺寸開啟 Google AI 獨立小視窗：
  ```
  window.open(url, "ai_smartbook_google_relay", "popup=yes,width=900,height=820,left=...")
  ```
  不遮擋主畫面。不使用 iframe 嵌入 Google（Same-Origin Policy 禁止）。

- **螢幕左側（本系統）**立即彈出「Google AI 問答接力模擬器」專屬 Modal（`GoogleAiRelaySimulatorModal.tsx`）。**未來規劃（尚未實作）**：若瀏覽器支援 `documentPictureInPicture`，可一鍵切換為永遠置頂在 Google 視窗旁的懸浮接力小窗。

### 2.2 鎖定當前題目（activeRelayEntryId）

模擬器開啟時即鎖定剛送出的 `entry.id`。只要貼入的內容不是另一題的 `udm=50&q=其他題目` 網址，**直接 100% 綁定至當前題目**，跳過 `canAutoBindAnswer` 的 67% token 重疊門檻（`canAutoBindAnswer` 定義於 `learningHistory.ts:485`），但仍保留衝突題目網址的保護。

明確帶入 `preferredEntry`／`explicitTargetEntry` 時免除 67% 門檻的邏輯位於 `useShareIntake.ts:97-105`：

```typescript
// useShareIntake.ts:97-105
if (options?.explicitTargetEntry) {
  if (source && normalizeQuestion(source.question) !== normalizeQuestion(preferredEntry.question)) {
    requireExplicitChoice(rawAnswer, [preferredEntry, ...binding.matches.filter((entry) => entry.id !== preferredEntry.id)].slice(0, 3));
    return { saved: false };
  }
  return { saved: saveIntake(preferredEntry, rawAnswer) === "saved" };
}
```

## 3. 四重自動貼回通道

### 3.1 通道 A — 視窗切回自動感測貼回（Zero-Click Auto-Paste on Focus）

模擬器開啟期間監聽 `window.addEventListener("focus")` 與 `visibilitychange`。當學員在右側 Google AI 點擊「複製」後，**滑鼠只要移回左側視窗點一下**，若剪貼簿權限已允許（或透過 `navigator.clipboard.readText()` 可讀且內容非空、非舊題目），**0 按鍵自動貼回、自動顯示整理後預覽並完成存檔**。

**失敗降級行為**：若 `navigator.clipboard.readText()` 被瀏覽器拒絕（權限封鎖或焦點不在頁面），安靜降級，不跳出阻斷提示。學員可改用通道 B 或 C。

### 3.2 通道 B — 免權限全域 paste 監聽

模擬器開啟時自動聚焦接收區並監聽全域 `paste` 事件（`event.clipboardData`）。瀏覽器原生 `paste` 事件**完全不需要剪貼簿讀取權限**。

同時解析：
- `clipboardData.getData("text/plain")`：純文字回答
- `clipboardData.getData("text/html")`：HTML 格式回答

**HTML 解析安全規則**：
- **必須**使用 `DOMParser` 或安全純文字擷取來抽取回答文字
- **嚴禁** `innerHTML` 指派、`document.write`、`eval`、`dangerouslySetInnerHTML`
- 只由 `DOMParser` 取 `textContent`／安全正則抽 URL
- 外部網址僅可用於 `sourceUrl` 欄位與 `<a href>`（需限制 http/https 協定），不得注入 DOM 結構

**失敗降級行為**：若 `text/plain` 和 `text/html` 均為空，`absorbTransfer` 直接 `return false`，無任何 UI 提示，靜默失敗。學員可改用通道 A、C 或 D。

### 3.3 通道 C — 跨視窗拖放貼回（Drag & Drop）

因為左右並排顯示，學員在右側 Google AI 反白答案文字後，**直接用滑鼠左鍵把文字「拖曳（Drag）」進左側模擬器接收區放開**（`onDrop` 讀取 `dataTransfer.getData("text/plain")` 與 `text/html`），**連 `Ctrl+C` / `Ctrl+V` 都不用按**，放開滑鼠即自動貼回。

行為與通道 B 一致：同時讀取 `text/plain` 與 `text/html`，HTML 解析遵循相同安全規則。

**失敗降級行為**：若 `dataTransfer` 為 `null`，`onDrop` 直接 `return`；若 `dataTransfer` 存在但 `text/plain` 和 `text/html` 均為空，`absorbTransfer` 直接 `return false`。兩者均為靜默失敗，無任何 UI 提示。學員可改用通道 A、B 或 D。

### 3.4 通道 D — URL-only 兩段式接力

若學員第一次只複製了 Google 網址（例如點「分享連結」），模擬器**不報錯退件**，而是：

1. 先嘗試儲存 `sourceUrl`，依 `acceptIncomingAnswer` 回傳結果分支：
   - **`saved=true`**：顯示「✅ 第 1 步完成：已自動綁定來源網址！請再複製右側 AI 回答文字（或直接拖曳進來）即可完成」，並進入 `await-answer` 狀態。
   - **`saved=false`**：顯示「第 1 步未完成：此題的來源連結沒有重新保存（可能已有舊來源或多筆同題皆已綁定）；請直接複製右側 AI 回答文字貼上。」，不進入 `await-answer`。
2. 第二段再接內文，不視為錯誤退件。

此條件式行為對應 `GoogleAiRelaySimulatorModal.tsx:199-210` 的 `same-question-url` 分支：

```typescript
// GoogleAiRelaySimulatorModal.tsx:199-210
if (decision.kind === "same-question-url") {
  const result = onIntake(decision.sourceUrl, entry, { explicitTargetEntry: true });
  if (result && result.saved) {
    setState("await-answer");
    setStatus("✅ 第 1 步完成：已自動綁定來源網址！請再複製右側 AI 回答文字（或直接拖曳進來）即可完成。");
  } else {
    setStatus("第 1 步未完成：此題的來源連結沒有重新保存（可能已有舊來源或多筆同題皆已綁定）；請直接複製右側 AI 回答文字貼上。");
  }
  return true;
}
```

此邏輯對應 `useShareIntake.ts:73-85` 的 `extraction.status !== "accepted"` 分支：

```typescript
// useShareIntake.ts:73-85
const extraction = extractSharedAnswerText(rawAnswer, sharedUrl);
if (extraction.status !== "accepted") {
  if (source && sourceEntry) {
    const sourceStatus = saveSourceIntake(sourceEntry, source.sourceUrl);
    const message = "已保存搜尋好朋友來源連結；尚未保存回答文字。請使用「從剪貼簿帶回回答」，或展開手動貼上備援。";
    setGoogleStatus(message);
    setHistoryStatuses((messages) => ({ ...messages, [sourceEntry.id]: message }));
    return { saved: sourceStatus === "saved" || sourceStatus === "already_saved" };
  }
  // ...
  return { saved: false };
}
```

## 4. 安全邊界

### 4.1 HTML 解析安全

`text/html` 解析**嚴禁**以下操作：
- `innerHTML` 指派
- `document.write`
- `eval`
- `dangerouslySetInnerHTML`

只允許：
- `DOMParser` 的 `textContent` 提取
- 安全正則表達式抽取 Google `search?udm=50` 來源網址

### 4.2 來源網址限制

外部網址僅限 `http(s)` 協定，僅可用於：
- `sourceUrl` 欄位儲存
- `<a href>` 連結展示（需 `rel="noopener noreferrer"`）

不得將外部網址注入 DOM 結構。`extractGoogleAiSourceUrl`（`learningHistory.ts:317`）已驗證：
- 僅接受 `https://www.google.com/search` 且包含 `udm=50` 與 `q` 參數
- 拒絕 `http://`（非 HTTPS）
- 拒絕非標準埠號（如 `:444`）
- 拒絕本機 origin 網址

### 4.3 67% 門檻豁免條件

67% token 重疊門檻（`canAutoBindAnswer`）僅在以下條件下豁免：
- 明確綁定當前題（`activeRelayEntryId` 存在）
- 貼入內容**不含**衝突題目的 URL（`udm=50&q=其他題目`）

若貼入內容包含另一題的 `udm=50&q=` 網址，`normalizeQuestion`（`useShareIntake.ts:101`）會比對 `source.question` 與 `preferredEntry.question` 的標準化結果，確認是否為衝突題目，若是則拒絕直接綁定。`findGoogleAiSourceEntry`（`learningHistory.ts:330`）僅以 `q` 參數尋找對應的 entry，不做衝突判斷。

## 5. 與既有 Android Share Target 並存

接力模擬器**不影響**既有 Android Share Target 流程：

- Android Share Target 透過 `navigator.serviceWorker` 接收分享意圖（`useShareIntake.ts:131-145`）
- 接力模擬器僅在桌面環境（Windows）的 `google-ai` strategy 下啟動
- `useShareIntake.ts` 的 `acceptIncomingAnswer` 函數同時服務兩條路徑
- 所有關聯測試（`learningHistory.test.ts`）保持綠色

`useGuestQuestion.ts:202-236` 的 `submitGoogleAiQuestion` 將改為桌面並排 Popup 加啟動 `activeRelayEntry`，保留既有 `manual`/`image`/`file` 行為與 cooldown，**不破壞**既有 `google-confirm-hint.test.tsx`、`guest-cooldown.test.tsx`。

## 6. 實機模擬測試（Playwright Chromium E1–E7）執行與驗收指南

### 6.1 執行命令

```bash
node scripts/student-relay-e2e.mjs
```

或透過根目錄 `package.json` 腳本（R18-T4 新增後）：

```bash
corepack pnpm@9.15.0 run e2e:student-relay
```

> **注意**：`e2e:student-relay` 腳本定義於根層 `package.json`，不可使用 `--filter AI-Stu-R1` 過濾，否則會靜默 no-op（輸出「None of the selected packages has a "e2e:student-relay" script」且回 exit 0）。

### 6.2 前置條件

1. **playwright-core 已安裝**：項目 `node_modules` 已包含 `playwright-core` 套件。
2. **本地 Chromium 已安裝**：PM 已執行 `playwright-core install chromium` 安裝 headless Chromium 瀏覽器。**禁止自行執行安裝命令**。
3. **靜態 SPA 伺服器**：腳本在 `apps/AI-Stu-R1/dist` 缺失或過舊時執行 build，然後以內建 HTTP 伺服器服務已構建的 SPA（loopback `127.0.0.1`），**不啟動或連接 Vite 開發伺服器**。
4. **不連外網**：腳本攔截所有指向 `google.com` 的 popup 請求，回傳本地模擬的 Google AI 結果頁，不觸發反爬蟲機制、不消耗外部 API 配額。

### 6.3 輸出產物

腳本執行後輸出結構化 JSON 報告至：

```
release-artifacts/phase3a/student-relay-e2e.json
```

報告包含每個 E1–E7 測試用例的 PASS/FAIL 狀態、耗時與斷言明細。

### 6.4 E1–E7 覆蓋矩陣

| 編號 | 測試名稱 | 覆蓋範圍 | 驗證要點 |
|------|----------|----------|----------|
| **E1** | 通道 B 免權限 `Ctrl+V` / `paste` | 全域貼上監聽 | 派發真實瀏覽器 `paste` 事件（含 `text/plain` 與 `text/html` `udm=50` 來源連結），驗證 `localStorage` 已存入 `rawAnswer`、`organizedAnswer` 與 `sourceUrl`，且 Modal 顯示「✅ 已收到回答」 |
| **E2** | 通道 A 視窗切回 `focus` 自動讀取剪貼簿 | 焦點偵測自動貼回 | `context.grantPermissions(['clipboard-read','clipboard-write'])` 後寫入新答案並派發合成 `focus`/`visibilitychange` 事件（**非切換真實視窗焦點**），驗證 0 按鍵自動貼回存檔 |
| **E3** | 剪貼簿權限拒絕靜默降級 | 權限拒絕處理 | 未授權 `clipboard-read` 下觸發 `focus`，驗證無錯誤彈窗、Modal 維持待命且通道 B 仍可正常貼回 |
| **E4** | 通道 C 跨視窗 `drop` 拖放貼回 | 拖放通道 | 對 Modal 拖放區派發 `drop` 事件，驗證答案自動貼回存檔 |
| **E5** | F1 防呆：舊剪貼簿快照與題目本身不誤存 | 剪貼簿舊內容過濾 | 開窗前剪貼簿預置舊文字 `X` 及題目文字本身，觸發 `focus` 驗證靜默忽略、零誤存 |
| **E6** | 防呆與 XSS 安全 | 他題網址攔截 + 腳本注入防護 | 驗證他題 `udm=50` 網址觸發 `conflict` 攔截、非 Google 網址被忽略、`<script>`/`<img onerror>` HTML 注入不執行（`window.__relay_pwned === undefined`） |
| **E7** | 通道 D 兩段式 + Popup 同名視窗重用 | URL-only 接力 + 視窗管理 | 驗證第 1 步綁定同題 `udm=50` 網址、第 2 步完成回答；以 spy 覆寫 `window.open` 斷言呼叫次數、目標名稱與 URL。**注意**：headless Chromium/CDP 不會合併同名視窗，因此僅量測「呼叫意圖」，不證明第二個真實 popup 被重用 |

### 6.5 測試狀態說明

**重要**：`scripts/student-relay-e2e.mjs` 腳本由 R18-T4 同事負責實作與首次實跑。在 R18-T4 報告（`reports/dispatch/R18-T4.md`）明確記錄 E1–E7 全部 PASS 之前，**不得宣稱測試通過**。本文檔僅記錄執行方式與驗收標準，不預設測試結果。

### 6.6 合成瀏覽器模擬與真人測試的區別

此 Playwright Chromium 自動化測試為 **headless 瀏覽器模擬**，其執行結果與真人操作存在本質差異：

- **合成事件 vs. 真人操作**：腳本派發合成 `focus`/`visibilitychange`/`paste`/`drop` 事件，而非切換真實視窗焦點或手動按鍵。這些合成事件在 headless 環境中可觸發對應的 JavaScript 回調，但不等同於真人跨視窗操作的完整體驗。
- **不替代真實 Windows Chrome/Edge 測試**：Headless 環境與有頭瀏覽器在剪貼簿權限提示、焦點行為、拖放手感等方面存在差異。自動化測試 PASS 不代表真人操作一定成功。
- **Popup 重用僅量測呼叫意圖**：headless Chromium/CDP 不會合併同名視窗，E7 僅以 spy 斷言 `window.open` 的呼叫次數、目標名稱與 URL，不證明第二個真實 popup 被重用。
- **不替代 Android Share Target 測試**：此測試僅覆蓋桌面環境的 `google-ai` strategy，Android Share Target 需另行在真實裝置上驗證。

建議在自動化測試全數 PASS 後，仍進行至少一次真人 Windows Chrome/Edge 端到端確認，以驗證剪貼簿權限提示、視窗切換手感與 Popup 重用等環境依賴行為。

## 7. 常見問題

### Q1：剪貼簿權限被封鎖怎麼辦？

使用通道 B（全域 `paste` 監聽，免 `clipboard.readText` 權限）或通道 C（拖放）。這兩條通道不依賴 `navigator.clipboard.readText()`。

### Q2：Google AI 回答換句話說，系統拒絕存入？

接力模擬器鎖定當前題目後，直接 100% 綁定至當前題目，跳過 67% token 重疊門檻。只有當貼入內容包含另一題的 `udm=50&q=` 網址時才會拒絕。

### Q3：只複製到 Google 網址怎麼辦？

使用通道 D（URL-only 兩段式）：先儲存網址，再複製/拖放回答文字。模擬器會依 `acceptIncomingAnswer` 回傳結果顯示「第 1 步完成」或「第 1 步未完成」提示引導完成（`GoogleAiRelaySimulatorModal.tsx:199-210`）。

### Q4：手機端能用接力模擬器嗎？

手機端繼續使用既有的 Android Share Target 流程。接力模擬器專為 Windows 桌面環境設計。

## 8. 相關檔案

| 檔案 | 說明 |
|------|------|
| `apps/AI-Stu-R1/src/pages/public-home/GoogleAiRelaySimulatorModal.tsx` | 接力模擬器 Modal 組件（R16-T4 新增） |
| `apps/AI-Stu-R1/src/pages/public-home/GoogleAiRelaySimulatorModal.test.tsx` | 接力模擬器單元測試（R16-T4 新增） |
| `apps/AI-Stu-R1/src/pages/public-home/useGuestQuestion.ts` | 送出問題邏輯，`submitGoogleAiQuestion`（:202-236） |
| `apps/AI-Stu-R1/src/pages/public-home/useShareIntake.ts` | 回答接收與綁定邏輯，`acceptIncomingAnswer`（:68-128） |
| `apps/AI-Stu-R1/src/pages/public-home/LearningHistoryPanel.tsx` | 學習紀錄面板，`pasteGoogleAnswer`（:58-69） |
| `apps/AI-Stu-R1/src/pages/public-home/PublicHero.tsx` | 首頁組件，策略切換與狀態顯示 |
| `apps/AI-Stu-R1/src/learningHistory.ts` | 學習歷史核心，`canAutoBindAnswer`（:485）、`extractGoogleAiSourceUrl`（:317）、`findAnswerBinding`（:476）、`normalizeQuestion`（:429） |
| `apps/AI-Stu-R1/src/styles/13-public-home-v2.css` | 首頁樣式（R16-T4 修改） |
