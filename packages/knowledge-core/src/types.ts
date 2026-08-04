export const KNOWLEDGE_ARTIFACT_SCHEMA_VERSION = 1 as const;

export type KnowledgeScopeType =
  | "private"
  | "course"
  | "project"
  | "room"
  | "organization"
  | "public";

export interface KnowledgeScope {
  type: KnowledgeScopeType;
  id: string;
}

export type KnowledgePrincipalType =
  | "user"
  | "role"
  | "group"
  | "service_account";

export interface KnowledgePrincipal {
  type: KnowledgePrincipalType;
  id: string;
}

export interface KnowledgeAcl {
  visibility: "restricted" | "tenant" | "public";
  allow: KnowledgePrincipal[];
  deny: KnowledgePrincipal[];
}

export type KnowledgeSource =
  | "book"
  | "pdf"
  | "github"
  | "qm"
  | "slack"
  | "drive"
  | "manual";

export type KnowledgeArtifactType =
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

export interface KnowledgeCitation {
  label: string;
  locator?: string;
  url?: string;
}

/**
 * The source-independent contract between ingestion and retrieval.
 *
 * Deterministic fields such as tenant, source identity, timestamps and ACL
 * must be populated from trusted source data. LLM enrichment belongs only in
 * metadata and must never overwrite those fields.
 */
export interface KnowledgeArtifact {
  id: string;
  tenantId: string;
  scope: KnowledgeScope;
  source: KnowledgeSource;
  sourceRef: string;
  sourceUrl?: string;
  parentArtifactId?: string;
  artifactType: KnowledgeArtifactType;
  title?: string;
  document: string;
  metadata: Record<string, unknown>;
  sourceTimestamp?: string;
  contentHash: string;
  acl: KnowledgeAcl;
  citation: KnowledgeCitation;
  qualityScore?: number;
  schemaVersion: typeof KNOWLEDGE_ARTIFACT_SCHEMA_VERSION;
}

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

export type KnowledgeQueryIntent =
  | "lookup"
  | "explain"
  | "compare"
  | "troubleshoot"
  | "timeline"
  | "unknown";

export interface KnowledgeQueryFilters {
  sources?: KnowledgeSource[];
  artifactTypes?: KnowledgeArtifactType[];
  projectIds?: string[];
  courseIds?: string[];
  authors?: string[];
  dateFrom?: string;
  dateTo?: string;
}

export interface KnowledgeQueryPlan {
  originalQuery: string;
  rewrittenQueries: string[];
  intent: KnowledgeQueryIntent;
  filters: KnowledgeQueryFilters;
  requiredEntities: string[];
}

export interface RetrievalScores {
  dense?: number;
  lexical?: number;
  fused?: number;
  rerank?: number;
}

export interface RetrievalHit {
  artifactId: string;
  document: string;
  metadata: Record<string, unknown>;
  source: KnowledgeSource;
  artifactType: KnowledgeArtifactType;
  sourceUrl?: string;
  sourceTimestamp?: string;
  scores: RetrievalScores;
  citation: KnowledgeCitation;
}

export interface ContextPack {
  queryPlan: KnowledgeQueryPlan;
  hits: RetrievalHit[];
  retrievalTraceId: string;
  estimatedTokens: number;
}

export type GroundedAnswerConfidence = "high" | "medium" | "low";

export type GroundedAnswerAbstentionReason =
  | "NO_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "ACCESS_RESTRICTED"
  | "CONFLICTING_EVIDENCE";

export interface GroundedAnswer {
  answer: string;
  citations: Array<KnowledgeCitation & { artifactId: string }>;
  confidence: GroundedAnswerConfidence;
  retrievalTraceId: string;
  abstained: boolean;
  abstentionReason?: GroundedAnswerAbstentionReason;
}

export interface KnowledgeActorContext {
  tenantId: string;
  principal: KnowledgePrincipal;
  roles: string[];
  groups: string[];
  accessibleScopes: KnowledgeScope[];
}
