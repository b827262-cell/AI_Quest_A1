import type { RagCitation, RagClaimGrounding, RagRequest, RagScope } from "./contracts";

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

// ---------------------------------------------------------------------------
// Independent GroundingValidator port
// ---------------------------------------------------------------------------

/**
 * The authoritative support verdict, decided by the validator — not by the
 * generator. The generator's own confidence is deliberately excluded from
 * this type so a model can never self-approve.
 */
export type GroundingVerdict = "verified" | "partial" | "abstained";

export type ClaimSupportStatus = "supported" | "unsupported";

export type ValidatedClaimSupport = {
  claimId: string;
  status: ClaimSupportStatus;
  /** Which cited chunk ids actually back this claim (subset of citations). */
  supportedByChunkIds: string[];
  /** Risk category for the claim, used for high-risk UI emphasis. */
  riskCategory?: import("./contracts").RagClaimRiskCategory;
  /** Reason code when unsupported (for telemetry/audit, not user-facing). */
  reasonCode?: string;
};

export type GroundingValidationInput = {
  requestId: string;
  /** Sanitized final answer string (post redaction, pre-response). */
  answer: string;
  /** Claims decomposed from the answer, with answer-relative offsets. */
  claims: RagClaimGrounding[];
  /** Citation coordinates already structurally validated. */
  citations: RagCitation[];
  /** The exact retrieved-and-screened chunks for the request scope. */
  retrievedChunks: readonly RetrievedChunk[];
  /** Authorization scope; out-of-scope chunks must never support a claim. */
  scope: RagScope;
  signal?: AbortSignal;
};

export type GroundingValidationResult = {
  verdict: GroundingVerdict;
  claimSupport: ValidatedClaimSupport[];
  unsupportedClaimCount: number;
  /** Identity/version recorded for audit; never used to override the verdict. */
  validatorIdentity: string;
};

/**
 * Independent grounding validator, decoupled from the generator invocation.
 *
 * Contract rules:
 *   - The validator MUST NOT trust the generator's confidence.
 *   - On timeout, malformed input, or any internal error the validator MUST
 *     return verdict "abstained" (fail-closed), never "verified".
 *   - Generator/validator disagreement resolves to the validator's verdict.
 */
export interface GroundingValidator {
  validate(input: GroundingValidationInput): Promise<GroundingValidationResult>;
}
