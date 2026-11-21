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

## 6. 常見問題

### Q1：剪貼簿權限被封鎖怎麼辦？

使用通道 B（全域 `paste` 監聽，免 `clipboard.readText` 權限）或通道 C（拖放）。這兩條通道不依賴 `navigator.clipboard.readText()`。

### Q2：Google AI 回答換句話說，系統拒絕存入？

接力模擬器鎖定當前題目後，直接 100% 綁定至當前題目，跳過 67% token 重疊門檻。只有當貼入內容包含另一題的 `udm=50&q=` 網址時才會拒絕。

### Q3：只複製到 Google 網址怎麼辦？

使用通道 D（URL-only 兩段式）：先儲存網址，再複製/拖放回答文字。模擬器會依 `acceptIncomingAnswer` 回傳結果顯示「第 1 步完成」或「第 1 步未完成」提示引導完成（`GoogleAiRelaySimulatorModal.tsx:199-210`）。

### Q4：手機端能用接力模擬器嗎？

手機端繼續使用既有的 Android Share Target 流程。接力模擬器專為 Windows 桌面環境設計。

## 7. 相關檔案

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
