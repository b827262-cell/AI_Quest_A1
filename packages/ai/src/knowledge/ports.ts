import type {
  ContextPack,
  KnowledgeActorContext,
  KnowledgeArtifact,
  KnowledgeQueryPlan,
  RetrievalHit,
} from "./types.js";

export interface SourceItem {
  externalId: string;
  sourceRef: string;
  sourceUrl?: string;
  sourceTimestamp?: string;
  contentHash: string;
  payload: unknown;
}

export interface KnowledgeConnectorPullInput {
  cursor?: string;
  limit: number;
}

export interface KnowledgeConnectorPullResult {
  items: SourceItem[];
  nextCursor?: string;
}

export interface KnowledgeConnector {
  pull(input: KnowledgeConnectorPullInput): Promise<KnowledgeConnectorPullResult>;
}

export interface KnowledgeArtifactRepository {
  upsertArtifacts(artifacts: KnowledgeArtifact[]): Promise<void>;
  tombstoneBySourceRefs(sourceRefs: string[]): Promise<void>;
  getByIds(ids: string[], actor: KnowledgeActorContext): Promise<KnowledgeArtifact[]>;
}

export interface KnowledgeArtifactProcessor {
  process(item: SourceItem): Promise<KnowledgeArtifact[]>;
}

export interface EmbeddingOptions {
  model: string;
  dimensions?: number;
}

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  embed(texts: string[], options: EmbeddingOptions): Promise<EmbeddingResult[]>;
}

export interface StructuredExtractionInput<T> {
  instruction: string;
  content: string;
  schemaName: string;
  schemaVersion: number;
  validate(value: unknown): T;
}

export interface StructuredExtractionProvider {
  extract<T>(input: StructuredExtractionInput<T>): Promise<T>;
}

export interface RerankOptions {
  model: string;
  topK: number;
}

export interface RerankResult {
  index: number;
  score: number;
}

export interface RerankProvider {
  rerank(
    query: string,
    documents: string[],
    options: RerankOptions,
  ): Promise<RerankResult[]>;
}

export interface KnowledgeQueryPlanner {
  plan(query: string, actor: KnowledgeActorContext): Promise<KnowledgeQueryPlan>;
}

export interface KnowledgeRetriever {
  retrieve(
    plan: KnowledgeQueryPlan,
    actor: KnowledgeActorContext,
  ): Promise<RetrievalHit[]>;
}

export interface KnowledgeContextPacker {
  pack(input: {
    plan: KnowledgeQueryPlan;
    hits: RetrievalHit[];
    retrievalTraceId: string;
    maxTokens: number;
  }): Promise<ContextPack>;
}

export interface KnowledgeRetrievalTrace {
  id: string;
  queryPlan: KnowledgeQueryPlan;
  candidateCounts: {
    dense: number;
    lexical: number;
    fused: number;
    reranked: number;
    final: number;
  };
  durationsMs: {
    planning: number;
    dense: number;
    lexical: number;
    fusion: number;
    rerank: number;
    packing: number;
    total: number;
  };
}

export interface KnowledgeTraceSink {
  record(trace: KnowledgeRetrievalTrace): Promise<void>;
}
