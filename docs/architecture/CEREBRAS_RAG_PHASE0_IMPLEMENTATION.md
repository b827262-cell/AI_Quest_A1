# Cerebras-style RAG Phase 0 Implementation

- Date: 2026-08-04
- Branch: `feat/cerebras-rag-knowledge-base`
- Architecture: `docs/architecture/CEREBRAS_RAG_KNOWLEDGE_BASE.md`

## Implemented scope

Phase 0 establishes source-independent knowledge contracts before adding a database, connector, embedding provider or live endpoint.

Public import:

```ts
import type {
  KnowledgeArtifact,
  KnowledgeRetriever,
  RetrievalHit,
} from "@ai-smartbook/ai/knowledge";

import { reciprocalRankFusion } from "@ai-smartbook/ai/knowledge";
```

Files:

```text
packages/ai/src/knowledge/
├── index.ts
├── ports.ts
├── rrf.ts
└── types.ts

packages/ai/test/knowledge/
└── rrf.test.ts
```

## Contracts established

- `KnowledgeArtifact`: narrow-waist artifact shared by ingestion and retrieval.
- `KnowledgeAcl` and `KnowledgeActorContext`: authorization context required by repositories and retrievers.
- `KnowledgeQueryPlan`: intent, query rewrites and metadata filters.
- `RetrievalHit` and `ContextPack`: retrieval output independent from answer generation.
- `GroundedAnswer`: citations, confidence and explicit abstention reason.
- Connector, artifact processor, repository, embedding, structured extraction, reranking, planner, retriever, context packer and trace sink ports.
- `reciprocalRankFusion()`: deterministic rank fusion for dense and lexical candidate lists.

## Transitional package placement

The target architecture defines a future standalone `knowledge-core` package. The current repository still uses the legacy `@ai-smartbook/*` package structure and a frozen pnpm lockfile.

To avoid introducing an unverified workspace importer and lockfile mutation, Phase 0 is exposed as the explicit `@ai-smartbook/ai/knowledge` subpath. The contracts have no dependency on provider SDKs, database clients or application code, so they can be moved to `@ai-quest/knowledge-core` later without changing their responsibilities.

Extraction criteria:

1. The project completes the planned package-name migration.
2. The lockfile is regenerated through the normal bootstrap environment.
3. At least two consumers use the contracts, such as ingestion and retrieval packages.
4. Boundary tests prove that the extracted package has no app, DB or provider dependency.

## Intentionally not implemented

- PostgreSQL or pgvector migrations.
- Live embedding, enrichment or reranking adapters.
- PDF, book, GitHub, QM or Slack connectors.
- Search or answer HTTP endpoints.
- Credentials, deployment or production data ingestion.

These belong to later PRs and require executable integration and security tests.

## Next implementation slice

1. Add deterministic artifact validation and quality gates.
2. Add fake in-memory repository and retrieval adapters.
3. Add ACL negative tests and a small golden retrieval dataset.
4. Define DB repository contracts and a PostgreSQL/pgvector migration plan.
5. Keep generation outside the retrieval tests so retrieval regressions remain visible.
