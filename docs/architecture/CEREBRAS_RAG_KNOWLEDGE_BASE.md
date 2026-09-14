# AI_Quest_A1 Cerebras-style RAG 知識庫架構

- 狀態：Proposed
- 日期：2026-08-04
- 適用專案：`AI_Quest_A1`
- 決策類型：Architecture / Knowledge Platform / RAG

## 1. 決策摘要

AI_Quest_A1 採用 Cerebras Knowledge 所公開之企業知識庫設計原則，建立系統級 RAG 知識庫。

本決策採用的是「Cerebras-style architecture」，不是將系統綁定到 Cerebras 模型、晶片或雲端服務。所有 LLM、Embedding、Reranker、向量儲存與資料連接器都必須透過公開介面注入並可替換。

核心決策如下：

1. 以單一 `KnowledgeArtifact` 契約作為 ingestion 與 retrieval 之間的窄腰介面。
2. 原始資料在向量化前，先執行結構化、Metadata 萃取、語意標記與品質閘門。
3. 對討論串、事件紀錄與長文件建立高階 distillation artifact，不只切割原文。
4. Retrieval 與 Answer Generation 解耦；檢索結果必須可獨立測試。
5. 預設採 Hybrid Retrieval：Metadata filter + Dense Vector + Lexical/BM25 + RRF + Rerank。
6. 所有答案必須提供來源引用，低信心或無資料時必須拒絕臆測。
7. 權限在檢索前執行，禁止先取回內容再於生成階段遮罩。
8. 第一階段使用 PostgreSQL + `pgvector`；SQLite 僅保留既有交易資料，不承擔正式向量檢索。

## 2. 問題定義

AI_Quest_A1 的知識會散落在不同來源：

- 教材 PDF、章節、題目、解析與教師補充內容。
- 管理端設定、操作手冊、維運 Runbook 與架構文件。
- GitHub 程式碼、Issue、Pull Request、Commit 與發布紀錄。
- 學員回饋、教師回覆、QM/Slack 對話與專案討論。
- 未來可能接入的 Google Drive、Gmail、Jira、Confluence 或其他內部系統。

只將文字固定切塊並做 Embedding，會產生下列問題：

- 討論結論與過程混在一起，無法判斷何者為最終決策。
- 同一事件在多個來源重複出現，檢索結果被近似內容佔滿。
- 缺少作者、時間、課程、租戶、專案、版本與權限等上下文。
- 查詢中的精確名稱、錯誤碼、檔名、版本號不一定適合純向量檢索。
- 無法客觀衡量檢索品質，Bug 容易被生成模型掩蓋。

因此，知識庫必須被視為獨立資料平台，而不是聊天功能中的一段 helper code。

## 3. 架構原則

### 3.1 Narrow Waist

所有來源經過各自的 connector 與 processor 後，都輸出同一種 artifact；所有 retriever 只依賴此契約，不依賴 Slack、GitHub、PDF 或資料庫的原始格式。

```ts
export interface KnowledgeArtifact {
  id: string;
  tenantId: string;
  scope: {
    type: "private" | "course" | "project" | "room" | "organization" | "public";
    id: string;
  };
  source: "book" | "pdf" | "github" | "qm" | "slack" | "drive" | "manual";
  sourceRef: string;
  sourceUrl?: string;
  artifactType:
    | "document"
    | "section"
    | "code"
    | "issue"
    | "pull_request"
    | "thread"
    | "thread_distillation"
    | "decision"
    | "incident"
    | "question_answer"
    | "feedback";
  title?: string;
  document: string;
  metadata: Record<string, unknown>;
  sourceTimestamp?: string;
  contentHash: string;
  acl: KnowledgeAcl;
  schemaVersion: number;
}
```

`metadata` 在儲存層可以是 JSONB，但 contracts 必須為常用欄位提供型別化 accessor 或 schema，禁止業務程式到處讀取不受控字串鍵值。

### 3.2 先理解，再 Embedding

Ingestion pipeline 不得直接執行「讀檔 → 固定切塊 → Embedding」。正式流程為：

```text
Collect
  -> Normalize
  -> Extract deterministic metadata
  -> LLM metadata enrichment
  -> Distill / classify / link entities
  -> Chunk or burst
  -> Quality gates
  -> Deduplicate and version
  -> Embed
  -> Index
```

LLM enrichment 至少應輸出：

- `summary`
- `topics`
- `entities`
- `document_kind`
- `language`
- `decision_status`
- `problem`
- `solution`
- `affected_components`
- `quality_score`
- `sensitivity`

不得讓 LLM 覆寫可從來源確定取得的作者、時間、repository、commit SHA、課程 ID、租戶 ID 或 ACL。

### 3.3 Thread Artifact

QM、Slack、Issue 與 PR 討論不得只以每則訊息為單位建索引。每個完整 thread 至少建立一份 `thread_distillation`：

```ts
export interface ThreadDistillation {
  questionOrGoal: string;
  participants: string[];
  timelineSummary: string;
  alternativesConsidered: string[];
  finalDecision?: string;
  resolution?: string;
  unresolvedItems: string[];
  relatedArtifacts: string[];
}
```

若 thread 很長，可以另外產生通過品質閘門的語意 burst；每個 burst 必須保存 parent thread ID、訊息範圍與原始引用。

### 3.4 Retrieval 與 Generation 解耦

Retrieval 必須先回傳結構化結果：

```ts
export interface RetrievalHit {
  artifactId: string;
  document: string;
  metadata: Record<string, unknown>;
  sourceUrl?: string;
  sourceTimestamp?: string;
  scores: {
    dense?: number;
    lexical?: number;
    fused?: number;
    rerank?: number;
  };
  citation: {
    label: string;
    locator?: string;
  };
}
```

`ai-orchestration` 只能消費 `RetrievalHit[]` 或 `ContextPack`，不得直接查向量資料庫。

## 4. 系統元件

```text
Data Sources
  ├─ Books / PDFs / Questions
  ├─ GitHub
  ├─ QM / Slack
  └─ Admin Uploads
          │
          ▼
Connector Adapters
          │
          ▼
Knowledge Ingestion Pipeline
  ├─ normalization
  ├─ metadata enrichment
  ├─ thread/document distillation
  ├─ quality gates
  └─ embedding/index writer
          │
          ▼
PostgreSQL + pgvector
  ├─ raw source records
  ├─ artifacts + metadata + ACL
  ├─ embeddings
  └─ ingestion jobs / versions
          │
          ▼
Knowledge Retrieval Service
  ├─ query understanding
  ├─ ACL + metadata filtering
  ├─ dense search
  ├─ lexical search
  ├─ RRF fusion
  ├─ reranking
  └─ context packing
          │
          ▼
AI Orchestration
  ├─ grounded answering
  ├─ citations
  ├─ confidence / abstention
  └─ feedback capture
```

## 5. Monorepo 放置位置

依照 `docs/ARCHITECTURE_AND_MODULARITY.md` 的邊界，新增：

```text
apps/
├── knowledge-worker/                # ingestion、排程、重建索引、connector jobs
├── admin-api/                       # 知識來源與索引管理 API
└── student-api/                     # 學員查詢與問答 API/BFF

packages/
├── knowledge-core/                  # artifact、ACL、query、retrieval domain 與 ports
├── knowledge-ingestion/             # normalization、enrichment、distillation pipeline
├── knowledge-retrieval/             # hybrid search、RRF、rerank、context packing
├── contracts/                       # HTTP DTO、Zod schema、事件 payload
├── db/                              # migration、repository、transaction
├── ai-gateway/                      # LLM、embedding、reranker adapter
├── ai-orchestration/                # grounded-answer workflow
└── observability/                   # ingestion/retrieval metrics、trace、audit
```

依賴方向：

```text
apps/*
  -> knowledge-ingestion / knowledge-retrieval / ai-orchestration
  -> knowledge-core ports
  -> db / ai-gateway adapters

knowledge-core
  -> contracts/shared types only
```

禁止事項：

- `student-api` 或 `admin-api` 直接發 SQL/pgvector 查詢。
- `knowledge-retrieval` 直接依賴特定 Provider SDK。
- Browser bundle 匯入 embedding client、DB client 或 secrets。
- 將 ACL 只放在 prompt 內處理。
- 將完整原始文件寫入 observability log。

## 6. 儲存模型

Cerebras 的窄腰概念可保持為邏輯介面；為了 AI_Quest_A1 的 ACL、版本、刪除與維運需求，實體資料表採正規化設計。

### 6.1 `knowledge_sources`

- `id`
- `tenant_id`
- `source_type`
- `external_id`
- `display_name`
- `config_ref`：只指向安全 credential/keychain，不存 secret
- `sync_cursor`
- `status`
- `created_at`
- `updated_at`

唯一鍵：`tenant_id + source_type + external_id`

### 6.2 `knowledge_source_items`

保存來源快照、版本與刪除狀態：

- `id`
- `source_id`
- `external_item_id`
- `source_url`
- `content_hash`
- `source_timestamp`
- `raw_payload_ref` 或經脫敏的 normalized payload
- `version`
- `deleted_at`

### 6.3 `knowledge_artifacts`

- `id`
- `tenant_id`
- `scope_type`
- `scope_id`
- `source_item_id`
- `parent_artifact_id`
- `artifact_type`
- `title`
- `document`
- `metadata JSONB`
- `acl JSONB`
- `source_timestamp`
- `content_hash`
- `schema_version`
- `quality_score`
- `created_at`
- `updated_at`
- `deleted_at`

索引：

- `(tenant_id, scope_type, scope_id)`
- `(artifact_type, source_timestamp DESC)`
- GIN(`metadata`)
- GIN(`acl`)，或將主要 ACL 欄位正規化
- `content_hash`
- PostgreSQL full-text `tsvector(document)`

### 6.4 `knowledge_embeddings`

- `artifact_id`
- `embedding_model`
- `embedding_dimension`
- `embedding vector(n)`
- `embedded_content_hash`
- `created_at`

同一 artifact 可在模型遷移期間同時存在多個 embedding 版本。

### 6.5 `knowledge_ingestion_jobs`

- `id`
- `source_id`
- `job_type`
- `status`
- `cursor_before`
- `cursor_after`
- `processed_count`
- `failed_count`
- `error_code`
- `started_at`
- `finished_at`

需要 idempotency key，重跑不得產生重複 artifact。

### 6.6 `knowledge_feedback`

- `id`
- `tenant_id`
- `query_id`
- `answer_id`
- `rating`
- `reason_code`
- `comment`
- `selected_artifact_ids`
- `created_at`

不得把使用者回饋直接當成檢索 ground truth；必須經過審核或離線評測流程。

## 7. Ingestion Pipeline

### 7.1 Connector

每個 connector 實作：

```ts
export interface KnowledgeConnector {
  pull(input: {
    cursor?: string;
    limit: number;
  }): Promise<{
    items: SourceItem[];
    nextCursor?: string;
  }>;
}
```

Connector 只負責取得資料與來源 ACL，不負責切塊、生成摘要或 Embedding。

第一階段 connector：

1. `book`：教材、章節、題目、解析。
2. `github`：本專案 docs、code、issue、PR、commit。
3. `manual`：管理員上傳 Markdown、TXT、PDF。

第二階段：

4. `qm/slack`：房間與個人 scope 討論。
5. `drive`：教案與行政文件。

### 7.2 Deterministic Metadata

先使用規則取得可信欄位：

- Source ID、URL、作者、建立/更新時間。
- GitHub repo、branch、path、SHA、Issue/PR number。
- Book、chapter、page、question ID、course ID。
- QM/Slack workspace、channel、thread、message range。
- Tenant、scope 與 ACL。

### 7.3 LLM Enrichment

LLM adapter 必須回傳經 Zod 驗證的 JSON。解析失敗時：

- 不得寫入半結構化 metadata。
- 可退回 deterministic metadata 並標示 `enrichment_status=failed`。
- 可重試，但需受 timeout、retry budget 與 dead-letter queue 控制。

Metadata prompt 與 schema 必須版本化：

- `enrichment_prompt_version`
- `enrichment_schema_version`
- `model`
- `provider`

### 7.4 Chunking / Burst

策略依 artifact type 決定，不使用單一全域 token 長度：

- 程式碼：以 symbol、class、function、module 為邊界。
- PDF/教材：以章節、標題、段落與頁碼為邊界。
- 問答：題目與解析保持同一 artifact。
- Thread：完整 distillation + 經品質檢查的 semantic bursts。
- Runbook/Incident：problem、symptoms、root cause、fix、verification 分段但互相連結。

每個 chunk/burst 保存：

- parent artifact ID
- chunk index
- start/end locator
- source citation locator
- overlap policy version

### 7.5 Quality Gates

進入正式索引前至少檢查：

- 內容非空且達最低資訊量。
- 語言、類型與必填 metadata 合法。
- ACL 完整。
- 無已知 secret、token、password、private key。
- 無大量模板、簽名檔、bot noise 或重複 quoted text。
- `content_hash` 去重。
- artifact 引用可以回到原始來源。

低品質內容可以保留 raw source item，但不得進入 production retrieval index。

## 8. Retrieval Pipeline

正式查詢流程：

```text
User query
  -> authenticate
  -> resolve tenant/scope/ACL
  -> classify intent
  -> normalize names, dates, IDs and versions
  -> derive metadata filters
  -> dense retrieval
  -> lexical retrieval
  -> RRF fusion
  -> deduplicate / diversify
  -> rerank
  -> context packing
  -> return RetrievalHit[]
```

### 8.1 Query Understanding

輸出結構：

```ts
export interface KnowledgeQueryPlan {
  originalQuery: string;
  rewrittenQueries: string[];
  intent: "lookup" | "explain" | "compare" | "troubleshoot" | "timeline" | "unknown";
  filters: {
    sources?: string[];
    artifactTypes?: string[];
    projectIds?: string[];
    courseIds?: string[];
    authors?: string[];
    dateFrom?: string;
    dateTo?: string;
  };
  requiredEntities: string[];
}
```

Query rewrite 不得移除錯誤碼、版本號、函式名稱、commit SHA、Issue number 等精確詞彙。

### 8.2 Hybrid Retrieval

預設候選數可由評測調整，初始值：

- Dense top K：40
- Lexical top K：40
- RRF fused：30
- Reranker input：20
- Final context hits：6–12

不可將固定閾值直接視為最終真理；所有值要透過 evaluation dataset 調整。

### 8.3 ACL Filter

ACL 必須在 SQL/vector search 階段作為硬條件：

```text
tenant_id = currentTenant
AND scope is accessible
AND source permissions allow current principal
AND deleted_at IS NULL
```

若來源權限變更，connector 必須同步 ACL 並觸發索引失效；不得等待下次內容更新。

### 8.4 RRF Fusion

Dense 與 lexical rankings 使用 Reciprocal Rank Fusion 合併，避免不同 score space 直接相加。

```text
RRF(d) = Σ 1 / (k + rank_i(d))
```

`k`、候選池大小及 source weighting 必須記錄在 retrieval trace，供離線重播。

### 8.5 Rerank 與 Context Packing

Reranker 只能看已通過 ACL 的候選項。Context packing 需：

- 去除近似重複內容。
- 優先保留最終決策與較新版本。
- 對衝突資料同時保留並標示時間與來源。
- 保留 citation locator。
- 控制每個來源佔用比例，避免單一 thread 壟斷上下文。

## 9. Grounded Answer

`ai-orchestration` 新增 `answerWithKnowledge()` 工作流：

```ts
export interface GroundedAnswer {
  answer: string;
  citations: Array<{
    artifactId: string;
    label: string;
    url?: string;
    locator?: string;
  }>;
  confidence: "high" | "medium" | "low";
  retrievalTraceId: string;
  abstained: boolean;
  abstentionReason?: "NO_EVIDENCE" | "INSUFFICIENT_EVIDENCE" | "ACCESS_RESTRICTED" | "CONFLICTING_EVIDENCE";
}
```

規則：

- 每個實質事實應可對應 citation。
- 不允許模型引用未出現在 context pack 的來源。
- 無足夠證據時應說明知識庫沒有足夠資料。
- 衝突資料需顯示日期、版本與不同來源，不可任選一方。
- 不在回答中暴露 ACL、隱藏文件標題或未授權來源的存在。

## 10. API 契約

### 10.1 管理端

- `POST /admin/knowledge/sources`
- `GET /admin/knowledge/sources`
- `POST /admin/knowledge/sources/:id/sync`
- `GET /admin/knowledge/jobs/:id`
- `POST /admin/knowledge/reindex`
- `POST /admin/knowledge/documents`
- `DELETE /admin/knowledge/documents/:id`
- `GET /admin/knowledge/health`
- `POST /admin/knowledge/evaluations/run`

所有寫入 API 都需 audit event。

### 10.2 查詢端

- `POST /knowledge/search`：只回傳 retrieval hits，供除錯與管理端使用。
- `POST /knowledge/answer`：產生 grounded answer。
- `POST /knowledge/feedback`：提交答案回饋。

正式學生端可透過 `student-api` BFF 暴露受限版本，不直接開放全部 metadata。

## 11. Provider 與設定

`ai-gateway` 新增三種 port：

```ts
export interface EmbeddingProvider {
  embed(texts: string[], options: EmbedOptions): Promise<EmbeddingResult[]>;
}

export interface StructuredExtractionProvider {
  extract<T>(input: StructuredExtractionInput<T>): Promise<T>;
}

export interface RerankProvider {
  rerank(query: string, documents: string[], options: RerankOptions): Promise<RerankResult[]>;
}
```

環境設定由 `@ai-quest/config/server` 驗證：

- `KNOWLEDGE_DATABASE_URL`
- `KNOWLEDGE_EMBEDDING_PROVIDER`
- `KNOWLEDGE_EMBEDDING_MODEL`
- `KNOWLEDGE_EMBEDDING_DIMENSION`
- `KNOWLEDGE_ENRICHMENT_PROVIDER`
- `KNOWLEDGE_ENRICHMENT_MODEL`
- `KNOWLEDGE_RERANK_PROVIDER`
- `KNOWLEDGE_RERANK_MODEL`
- `KNOWLEDGE_MAX_CONTEXT_TOKENS`
- `KNOWLEDGE_INGESTION_CONCURRENCY`

Cerebras 可作為 enrichment 或 answer-generation provider adapter，但不是必要依賴。Embedding model 也不得與 answer model 綁定。

## 12. 安全、隱私與治理

### 12.1 權限

- 每筆 artifact 必須有 `tenantId`、scope 與 ACL。
- Admin、teacher、student、agent、service account 使用明確 principal type。
- 個人 scope 不可被 organization query 讀取，除非使用者明確分享。
- Connector token 只放 keychain/secret manager。

### 12.2 資料生命週期

- 支援來源刪除、tombstone、reindex 與 embedding model migration。
- 來源刪除後，artifact 必須在可驗證時間內從檢索結果消失。
- Raw payload retention 與 artifact retention 分開設定。
- 所有重建索引工作必須可追蹤版本。

### 12.3 Prompt Injection

來源文件視為不可信資料：

- ingestion 階段標記疑似 prompt injection。
- retrieval context 以 data boundary 包裝。
- 文件中的「忽略系統指令」不得改變 agent policy。
- tool execution 不可由檢索內容直接觸發，仍需 orchestration policy 與授權。

### 12.4 敏感資訊

索引前執行 secret/PII scanner：

- API key、password、private key、session token 不得進索引。
- 個資依 tenant policy 遮罩或排除。
- Log、trace 只保存 ID、score、模型與延遲；預設不保存全文。

## 13. Observability

至少記錄：

### Ingestion

- connector latency / error rate
- items fetched / changed / deleted
- enrichment success rate
- quality gate rejection reasons
- duplicate rate
- embedding throughput / cost
- indexing lag

### Retrieval

- dense / lexical / fused / rerank latency
- candidate counts
- hit source distribution
- empty-result rate
- citation coverage
- abstention rate
- permission-filtered result count（僅聚合，不暴露文件）

### Answer

- groundedness / faithfulness score
- unsupported claim rate
- user feedback
- model/provider usage
- end-to-end latency

Trace 必須能重播 query plan 與 retrieval rankings，但不得保存未授權全文。

## 14. 評測策略

不得以「聊天看起來不錯」作為驗收。

### 14.1 Golden Dataset

建立至少 100 題專案內部評測集，涵蓋：

- 精確事實查詢。
- 課程/教材章節定位。
- GitHub 錯誤碼與檔案查詢。
- 最終決策與歷史討論區分。
- 跨文件整合。
- 時間範圍與版本限制。
- 衝突資料處理。
- 不存在答案時拒答。
- ACL 不可見資料測試。
- 中英文與混合技術詞彙。

### 14.2 Retrieval Metrics

- Hit Rate@K
- Recall@K
- MRR
- nDCG@K
- Metadata filter accuracy
- ACL leakage count（必須為 0）
- Duplicate ratio

### 14.3 Answer Metrics

- Faithfulness
- Citation correctness
- Citation completeness
- Answer relevance
- Abstention accuracy
- Conflict handling

### 14.4 Regression Gate

每次更換 embedding、chunking、prompt、RRF 參數、reranker 或 schema，都必須執行固定 evaluation suite，結果低於 baseline 時不得發布。

## 15. 分階段落地

### Phase 0：契約與測試骨架

- 建立 `knowledge-core`、contracts 與 ports。
- 定義 `KnowledgeArtifact`、ACL、query plan、retrieval hit。
- 建立 30 題最小 golden dataset。
- 加入 boundary tests，確認 server-only 依賴不進 browser bundle。

### Phase 1：教材與手動文件 MVP

- PostgreSQL + pgvector migration。
- `book` 與 `manual` connectors。
- deterministic metadata、基本 LLM enrichment。
- dense + lexical + RRF。
- `/knowledge/search`、`/knowledge/answer`。
- 答案 citations 與 abstention。

### Phase 2：GitHub 與企業文件

- GitHub docs/code/issue/PR connector。
- 程式碼 symbol chunking。
- thread distillation。
- reranker、deduplication、context diversity。
- 管理端來源、同步與索引狀態 UI。

### Phase 3：QM/Slack 與多人 Scope

- room/private/project scope ACL。
- 增量事件同步與 thread re-fetch。
- ACL change propagation。
- agent 使用的 retriever API。

### Phase 4：品質自動化

- 100+ 題 enterprise benchmark。
- synthetic question generation 僅用於擴充，不取代人工 ground truth。
- nightly evaluation、drift detection。
- embedding/reranker A/B 測試。
- feedback triage 與修復閉環。

## 16. MVP Definition of Done

第一版必須同時滿足：

1. 至少能索引教材與管理員上傳文件。
2. Metadata 包含 tenant、scope、source、artifact type、來源時間與 citation locator。
3. 檢索採 dense + lexical + RRF，不是單一 vector top-k。
4. Search endpoint 可獨立回傳 ranked hits 與 score breakdown。
5. Answer endpoint 對主要事實提供 citations。
6. 無證據問題會 abstain，不產生貌似合理的答案。
7. ACL leakage 自動測試為 0。
8. 刪除來源後，對應 artifact 不再被檢索。
9. Ingestion job 可重跑且不重複寫入。
10. Embedding model 與 LLM provider 可透過設定替換。
11. Unit、integration、contract、smoke、build boundary tests 全部通過。
12. Golden dataset 的 Hit Rate@10、MRR、citation correctness 有可重現 baseline。

## 17. 明確不做的事項

MVP 不包含：

- 以知識圖譜取代 RAG。
- 讓 Agent 自主修改或刪除知識來源。
- 用使用者私訊訓練全公司模型。
- 將所有原始 Email 或聊天室內容無條件納入索引。
- 只因 Cerebras inference 很快，就硬性綁定 Cerebras API。
- 將 83 分或任何影片示範分數直接視為本專案驗收標準。

## 18. 風險與對策

| 風險 | 對策 |
|---|---|
| Metadata enrichment 成本過高 | deterministic-first、批次、小模型、cache、只重處理變更內容 |
| LLM 產生錯誤標籤 | schema validation、可信欄位不可覆寫、保留模型/版本、可重建 |
| 索引重複與版本混亂 | source item version、content hash、parent link、tombstone |
| 權限外洩 | pre-retrieval ACL filter、negative tests、audit |
| Vector search 找不到精確技術詞 | lexical/BM25 + metadata filters + RRF |
| 長 thread 內容失真 | 保存原始 locator、distillation + bursts、引用回原文 |
| Provider lock-in | ports/adapters、模型版本欄位、雙索引 migration |
| 生成模型掩蓋 retrieval bug | `/knowledge/search` 獨立測試、retrieval benchmark |

## 19. 參考資料

- Cerebras, “How We Built Our Knowledge Base”, 2026-07-15: `https://www.cerebras.ai/blog/how-we-built-our-knowledge-base`
- 李哈利 | AI，影片：`https://www.youtube.com/watch?v=V5wNxQa4AOo`
- EnterpriseRAG-Bench: `https://arxiv.org/abs/2605.05253`
- LLM-generated metadata for enterprise retrieval: `https://arxiv.org/abs/2512.05411`

## 20. 後續執行順序

本文件合併後，第一個 implementation PR 應只處理 Phase 0：

1. 建立 knowledge contracts 與 package boundary。
2. 建立 DB migration 草案與 repository ports。
3. 建立最小 golden dataset 與 fake adapters。
4. 不接真實 Provider、不需要真實 API key。
5. 通過 typecheck、unit、contract 與 browser/server boundary tests 後，再進入 Phase 1。
