import type { RagCitation, RagRequest, RagScope } from "./contracts";

export type RagProviderId = "cerebras" | "fake";

export type RetrievedChunk = {
  id: string;
  content: string;
  label: string;
  sourceId?: string;
  sourceUrl?: string;
  locator?: string;
};

export type RetrieverInput = {
  requestId: string;
  query: string;
  topK: number;
  /** Authorization scope; retrievers must refuse to run without it. */
  scope: RagScope;
  signal?: AbortSignal;
};

export interface Retriever {
  retrieve(input: RetrieverInput): Promise<readonly RetrievedChunk[]>;
}

export type LlmGenerateInput = {
  requestId: string;
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type LlmGenerateOutput = {
  text: string;
  model: string;
  usage?: LlmUsage;
  latencyMs: number;
};

/** Provider-neutral LLM port. Vendor request/response shapes stop at adapters. */
export interface LlmProvider {
  readonly providerId: RagProviderId;
  readonly defaultModel: string;
  generate(input: LlmGenerateInput): Promise<LlmGenerateOutput>;
}

export type LlmCredential = {
  /** This type is server-only and must never be exported by a browser entry. */
  readonly apiKey: string;
};

/** Just-in-time server credential lookup. It may return no credential. */
export type ServerCredentialResolver = (
  providerId: Exclude<RagProviderId, "fake">
) => Promise<LlmCredential | undefined>;

export type RagModelAnswer = {
  answer: string;
  citations: RagCitation[];
  confidence: "high" | "medium" | "low";
};

export type RagTelemetryEvent = {
  requestId: string;
  provider: RagProviderId;
  status: "success" | "abstained" | "error";
  latencyMs: number;
  retrievedChunkCount: number;
  citationCount: number;
  errorCode?: string;
};

export interface RagTelemetrySink {
  record(event: RagTelemetryEvent): Promise<void>;
}

export class NoopRagTelemetrySink implements RagTelemetrySink {
  async record(): Promise<void> {}
}

export type RagApplication = {
  answer(request: RagRequest, signal?: AbortSignal): Promise<import("./contracts").RagResponse>;
};
