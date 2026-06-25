# AI-SmartBook-R2 模組治理與整合架構方案釋出

Date: 2026-06-25
Repository: b827262-cell/AI-SmartBook-R1-PR4
Source of truth: main

## 決策確認

最終整合 repo 是 AI-SmartBook-R1-PR4，主線是 main。
後續不再使用其他 repo 或 master 作為整合主線。

## 五大模組

| 模組 | 範圍 |
| --- | --- |
| pdf-reader-ai-core | PDF reader、頁碼、章節、截圖問答、筆記導覽 |
| book-content-pipeline | 書籍上傳、PDF parse、TOC、JSON index、內容切分 |
| admin-files-settings | Files、Settings、模型設定、R2 整合中心 |
| smart-ai-backend | provider runtime、prompt、知識服務、AI jobs |
| question-bank-solve | 題庫、我的題庫、一鍵解題、Smart Solve |

## 整合順序

1. baseline validation
2. schema / repository foundation
3. book-content-pipeline
4. pdf-reader-ai-core
5. question-bank-solve
6. admin-files-settings
7. smart-ai-backend
8. acceptance / rollback drill

## 後台狀態

每支功能 PR 都要能在後台 R2 模組整合中心反映狀態：綠、黃、紅、灰。

## 圖形化流程

```text
main
  -> docs governance
  -> baseline validation
  -> schema / repository foundation
  -> book-content-pipeline
  -> pdf-reader-ai-core
  -> question-bank-solve
  -> admin-files-settings
  -> smart-ai-backend
  -> acceptance / rollback drill
```

```text
R2 module center
  |- pdf-reader-ai-core
  |- book-content-pipeline
  |- admin-files-settings
  |- smart-ai-backend
  |- question-bank-solve
```

## PR 規則

每支功能 PR 必須包含：Scope、Module、Files changed、Validation、R2 module center status、Rollback、Not included。

## 合併判斷

本 PR 是 docs-only；確認 repo、main、五大模組與整合順序無誤後即可合併。

## 下一步

合併本 PR 後，先開 feat/r2-baseline-validation-20260625。
baseline 通過後，再開 feat/r2-schema-repository-foundation-20260625。
