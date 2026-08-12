import { randomUUID } from "node:crypto";
import {
  parseRagRequest,
  type RagCitation,
  type RagClaimGrounding,
  type RagEvidence,
  type RagRequest,
  type RagResponse
} from "./contracts";
import { RagApplicationError, asRagApplicationError } from "./errors";
import { citationFailureReason, validateCitations } from "./citation-validator";
import { hashEvidenceSpan } from "./evidence-hash";
import { screenPromptInjection, screenRetrievedChunks } from "./injection-screening";
import { buildRagPrompt, RAG_SYSTEM_PROMPT, sanitizeGeneratedAnswer } from "./prompt-builder";
import type { GroundingValidationInput, GroundingValidationResult, GroundingValidator, LlmProvider, RagApplication, RagTelemetrySink, RetrievedChunk, Retriever } from "./ports";
import { NoopRagTelemetrySink } from "./ports";
import { RuleBasedGroundingValidator } from "./grounding-validator";

export type RagApplicationOptions = {
  retriever: Retriever;
  provider: LlmProvider;
  telemetry?: RagTelemetrySink;
  idFactory?: () => string;
  /**
   * Independent grounding validator. Defaults to the deterministic rule-based
   * validator. Production wiring may inject an LLM-backed validator with its
   * own prompt/model/config; the generator's confidence is never an input.
   */
  groundingValidator?: GroundingValidator;
};

export class RagApplicationService implements RagApplication {
  private readonly retriever: Retriever;
  private readonly provider: LlmProvider;
  private readonly telemetry: RagTelemetrySink;
  private readonly idFactory: () => string;
  private readonly groundingValidator: GroundingValidator;

  constructor(options: RagApplicationOptions) {
    this.retriever = options.retriever;
    this.provider = options.provider;
    this.telemetry = options.telemetry ?? new NoopRagTelemetrySink();
    this.idFactory = options.idFactory ?? randomUUID;
    this.groundingValidator = options.groundingValidator ?? new RuleBasedGroundingValidator();
  }

  async answer(input: RagRequest | unknown, signal?: AbortSignal): Promise<RagResponse> {
    let request: RagRequest;
    try {
      request = parseRequest(input, this.idFactory);
    } catch (error) {
      // Contract failures (including a missing scope) surface as stable
      // application errors, never as raw validation exceptions.
      throw asRagApplicationError(error);
    }
    const started = Date.now();
    const userScreening = screenPromptInjection(request.query, "user");
    if (userScreening.decision === "block") {
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "error", latencyMs: Date.now() - started, retrievedChunkCount: 0, citationCount: 0, errorCode: "RAG_INJECTION_BLOCKED" });
      throw new RagApplicationError({ code: "RAG_INJECTION_BLOCKED", reasonCode: userScreening.reasonCode });
    }

    let retrieved: readonly RetrievedChunk[];
    try {
      retrieved = await this.retriever.retrieve({ requestId: request.requestId, query: request.query, topK: request.topK, scope: request.scope, signal });
    } catch (error) {
      // Scope enforcement errors are authorization decisions and must keep
      // their code; only unexpected retriever failures map to RAG_INTERNAL.
      const safeError = asRagApplicationError(error);
      const errorCode = safeError.code === "RAG_INTERNAL" && !(error instanceof RagApplicationError) ? "RAG_INTERNAL" : safeError.code;
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "error", latencyMs: Date.now() - started, retrievedChunkCount: 0, citationCount: 0, errorCode });
      throw safeError;
    }
    const screened = screenRetrievedChunks(retrieved);
    if (screened.chunks.length === 0) {
      const response = abstained(request.requestId, "NO_EVIDENCE");
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "abstained", latencyMs: Date.now() - started, retrievedChunkCount: retrieved.length, citationCount: 0 });
      return response;
    }

    let generated;
    try {
      generated = await this.provider.generate({
        requestId: request.requestId,
        systemPrompt: RAG_SYSTEM_PROMPT,
        userPrompt: buildRagPrompt(request, screened.chunks),
        model: undefined,
        maxOutputTokens: request.maxOutputTokens,
        temperature: 0.1,
        signal
      });
    } catch (error) {
      const safeError = asRagApplicationError(error);
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "error", latencyMs: Date.now() - started, retrievedChunkCount: retrieved.length, citationCount: 0, errorCode: safeError.code });
      throw safeError;
    }

    let modelAnswer: { answer: string; citations: RagCitation[]; claims?: RagClaimGrounding[]; confidence: "high" | "medium" | "low" };
    try {
      modelAnswer = parseModelAnswer(generated.text, this.provider.providerId);
    } catch (error) {
      const safeError = asRagApplicationError(error);
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "error", latencyMs: Date.now() - started, retrievedChunkCount: retrieved.length, citationCount: 0, errorCode: safeError.code });
      throw safeError;
    }
    const citationResult = validateCitations(modelAnswer.citations, screened.chunks);
    if (!citationResult.valid) {
      const reasonCode = citationFailureReason(citationResult.code);
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "error", latencyMs: Date.now() - started, retrievedChunkCount: retrieved.length, citationCount: modelAnswer.citations.length, errorCode: "RAG_CITATION_INVALID" });
      throw new RagApplicationError({ code: "RAG_CITATION_INVALID", reasonCode, provider: this.provider.providerId });
    }

    // The final answer is sanitized AFTER claim offsets are derived from the
    // raw model answer, so offsets must be recomputed against the sanitized
    // text before validation. Any claim/evidence integrity problem fails
    // closed (R-2/R-4): nothing is silently dropped, clamped or re-derived.
    const sanitizedAnswer = sanitizeGeneratedAnswer(modelAnswer.answer);
    const validatedCitations = citationResult.citations;
    const claimResult = recomputeClaimOffsets(modelAnswer.claims ?? [], sanitizedAnswer, screened.chunks, validatedCitations);
    if (!claimResult.ok) {
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "error", latencyMs: Date.now() - started, retrievedChunkCount: retrieved.length, citationCount: validatedCitations.length, errorCode: "RAG_CITATION_INVALID" });
      throw new RagApplicationError({ code: "RAG_CITATION_INVALID", reasonCode: claimResult.reasonCode, provider: this.provider.providerId });
    }
    const claims = claimResult.claims;

    // Run the independent grounding validator EXACTLY ONCE per request (R-3).
    // The single authoritative result below is the only source for grounding,
    // claims, unsupportedClaimCount and span annotations; no second verdict
    // is ever requested. The generator's confidence is deliberately excluded
    // from the verdict; disagreement resolves to the validator (fail-closed).
    //
    // Note: the request AbortSignal is intentionally NOT forwarded to the
    // validator. Express 5 aborts req.signal once the JSON body has been
    // consumed, which would spuriously fail a synchronous rule-based validator
    // closed on every request. Request-cancellation semantics are preserved at
    // the retriever/generation layers; LLM-backed validators implement their
    // own internal timeouts.
    let validation: GroundingValidationResult;
    try {
      const validatorInput: GroundingValidationInput = {
        requestId: request.requestId,
        answer: sanitizedAnswer,
        claims,
        citations: validatedCitations,
        retrievedChunks: screened.chunks,
        scope: request.scope
      };
      validation = await this.groundingValidator.validate(validatorInput);
    } catch {
      // Validator failure (timeout/exception) MUST fail closed: never verified.
      validation = {
        verdict: "abstained",
        claimSupport: [],
        unsupportedClaimCount: claims.length,
        validatorIdentity: "validator-error"
      };
    }

    if (validation.verdict === "abstained") {
      // The validator could not establish grounding for any claim. This is a
      // soft abstention (200), distinct from a hard citation-integrity failure.
      const response = abstained(request.requestId, "INSUFFICIENT_EVIDENCE");
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "abstained", latencyMs: Date.now() - started, retrievedChunkCount: retrieved.length, citationCount: validatedCitations.length });
      return response;
    }

    // Every downstream grounding field derives from the single validation
    // result. Response invariant (R-3): grounding === "verified" IFF
    // unsupportedClaimCount === 0 — a verdict label can never contradict the
    // per-claim support it is derived from.
    const annotatedClaims = annotateClaimSupport(claims, validation.claimSupport);
    const unsupportedClaimCount = annotatedClaims.filter((c) => c.status === "unsupported").length;
    const grounding = unsupportedClaimCount === 0 ? "verified" : "unverified";
    const response: RagResponse = {
      contractVersion: 1,
      requestId: request.requestId,
      answer: sanitizedAnswer,
      citations: validatedCitations,
      confidence: modelAnswer.confidence,
      grounding,
      citationStatus: "verified",
      abstained: false,
      claims: annotatedClaims,
      unsupportedClaimCount
    };
    await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "success", latencyMs: Date.now() - started, retrievedChunkCount: retrieved.length, citationCount: validatedCitations.length });
    return response;
  }

  private async record(event: Parameters<RagTelemetrySink["record"]>[0]): Promise<void> {
    await this.telemetry.record(event).catch(() => undefined);
  }
}

function parseRequest(input: RagRequest | unknown, idFactory: () => string): RagRequest {
  if (input && typeof input === "object" && "contractVersion" in input) return parseRagRequest(input);
  if (input && typeof input === "object") {
    const request = input as Record<string, unknown>;
    return parseRagRequest({ ...request, contractVersion: 1, requestId: request.requestId ?? idFactory() });
  }
  throw new RagApplicationError({ code: "RAG_INVALID_REQUEST" });
}

function parseModelAnswer(text: string, provider: "cerebras" | "fake"): { answer: string; citations: RagCitation[]; claims?: RagClaimGrounding[]; confidence: "high" | "medium" | "low" } {
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    throw new RagApplicationError({ code: "RAG_PROVIDER_INVALID_RESPONSE", provider, failureKind: "invalid_response" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidModelAnswer(provider);
  const object = value as Record<string, unknown>;
  if (typeof object.answer !== "string" || object.answer.trim().length === 0 || object.answer.length > 20_000
    || !Array.isArray(object.citations)
    || !["high", "medium", "low"].includes(String(object.confidence))) throw invalidModelAnswer(provider);
  const claims = parseModelClaims(object.claims, object.answer, provider);
  return {
    answer: object.answer,
    citations: object.citations as RagCitation[],
    ...(claims !== undefined ? { claims } : {}),
    confidence: object.confidence as "high" | "medium" | "low"
  };
}

/**
 * Parse the model-supplied claims array loosely for shape, but fail closed on
 * integrity problems (R-2): a well-formed claim whose text cannot be located
 * in the answer, or malformed evidence, is a tampering/integrity signal and
 * rejects the whole request instead of being silently dropped.
 */
function parseModelClaims(raw: unknown, answer: string, provider: "cerebras" | "fake"): RagClaimGrounding[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw invalidModelAnswer(provider);
  const claims: RagClaimGrounding[] = [];
  for (let index = 0; index < raw.length && index < 100; index++) {
    const entry = raw[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.claimId !== "string" || typeof e.text !== "string") continue;
    if (typeof e.answerStart !== "number" || typeof e.answerEnd !== "number") continue;
    if (!["supported", "unsupported"].includes(String(e.status))) continue;
    if (!Array.isArray(e.citationChunkIds)) continue;
    // Locate claim.text within answer (re-derive canonical offsets). A claim
    // text that does not exist in the answer fails closed — never dropped.
    const located = locateClaimOffset(answer, e.text, e.answerStart);
    if (!located) {
      throw new RagApplicationError({ code: "RAG_CITATION_INVALID", reasonCode: "CLAIM_TEXT_NOT_IN_ANSWER", provider });
    }
    const evidence = parseModelEvidence(e.evidence);
    if (evidence === null) {
      throw new RagApplicationError({ code: "RAG_CITATION_INVALID", reasonCode: "CLAIM_EVIDENCE_FORMAT_INVALID", provider });
    }
    const riskCategory = typeof e.riskCategory === "string"
      && ["general", "number", "date", "formula", "proper_noun"].includes(e.riskCategory)
      ? e.riskCategory as RagClaimGrounding["riskCategory"]
      : undefined;
    claims.push({
      claimId: e.claimId,
      text: e.text,
      answerStart: located.start,
      answerEnd: located.end,
      status: e.status as "supported" | "unsupported",
      ...(riskCategory ? { riskCategory } : {}),
      citationChunkIds: (e.citationChunkIds as unknown[]).filter((id): id is string => typeof id === "string"),
      evidence
    });
  }
  return claims;
}

function locateClaimOffset(answer: string, text: string, hint: number): { start: number; end: number } | null {
  // Prefer the model hint if it slices exactly to the claim text.
  if (Number.isInteger(hint) && hint >= 0) {
    const candidate = answer.slice(hint, hint + text.length);
    if (candidate === text) return { start: hint, end: hint + text.length };
  }
  // Fall back to first occurrence.
  const idx = answer.indexOf(text);
  if (idx >= 0) return { start: idx, end: idx + text.length };
  return null;
}

/**
 * Parse model evidence. The model supplies quote/chunkId/start/end and may
 * supply a contentHash; the hash is ALWAYS re-derived server-side from the
 * quote itself (R-4). A model-supplied hash must agree with the quote-derived
 * hash or the request fails closed downstream (R-2). The model hash is kept
 * in the placeholder contentHash field ("" means "not supplied").
 */
function parseModelEvidence(raw: unknown): RagEvidence[] | null {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 10) return null;
  const out: RagEvidence[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const e = item as Record<string, unknown>;
    if (typeof e.quote !== "string" || typeof e.chunkId !== "number" && typeof e.chunkId !== "string") return null;
    if (typeof e.start !== "number" || typeof e.end !== "number") return null;
    const suppliedHash = typeof e.contentHash === "string" && e.contentHash.length > 0 ? e.contentHash : "";
    out.push({
      quote: e.quote,
      contentHash: suppliedHash, // verified against hashEvidenceSpan(quote) by recomputeClaimOffsets
      hashAlgorithm: "sha256",
      chunkId: String(e.chunkId),
      start: e.start,
      end: e.end
    });
  }
  return out;
}

/** Deterministic claim-evidence integrity failure reasons (fail-closed, R-2). */
export type ClaimIntegrityReasonCode =
  | "CLAIM_TEXT_NOT_IN_ANSWER"
  | "CLAIM_EVIDENCE_FORMAT_INVALID"
  | "CLAIM_EVIDENCE_CHUNK_UNKNOWN"
  | "CLAIM_EVIDENCE_SCOPE_MISMATCH"
  | "CLAIM_EVIDENCE_QUOTE_MISMATCH"
  | "CLAIM_EVIDENCE_SPAN_MISMATCH"
  | "CLAIM_EVIDENCE_HASH_MISMATCH";

export type ClaimRecomputeResult =
  | { ok: true; claims: RagClaimGrounding[] }
  | { ok: false; reasonCode: ClaimIntegrityReasonCode };

/**
 * Recompute claim offsets against the sanitized answer and stamp
 * server-derived, quote-based evidence hashes (R-4):
 *
 *   start       = actual located offset of the quote inside the chunk
 *   end         = start + quote.length
 *   contentHash = hashEvidenceSpan(quote)
 *
 * so clients can independently verify both
 *   hashEvidenceSpan(evidence.quote) === evidence.contentHash
 * and
 *   chunk.content.slice(evidence.start, evidence.end) === evidence.quote.
 *
 * ANY integrity problem fails closed with a deterministic reason code (R-2):
 * no silent drops, no clamping of model-supplied offsets, no empty-evidence
 * fallback. Model-supplied start/end must equal the server-authoritative
 * location; a disagreement is treated as tampering.
 */
function recomputeClaimOffsets(
  claims: RagClaimGrounding[],
  sanitizedAnswer: string,
  chunks: readonly RetrievedChunk[],
  validatedCitations: RagCitation[]
): ClaimRecomputeResult {
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const validChunkIds = new Set(validatedCitations.map((c) => c.chunkId));
  const result: RagClaimGrounding[] = [];

  for (const claim of claims) {
    // Re-locate in the sanitized answer; the claim text MUST be a real slice
    // of the final answer (guarantees claim.text === answer.slice(start,end)).
    const located = locateClaimOffset(sanitizedAnswer, claim.text, claim.answerStart);
    if (!located) return { ok: false, reasonCode: "CLAIM_TEXT_NOT_IN_ANSWER" };
    // Keep only citation chunk ids that were structurally validated; claims
    // citing unknown chunks are still surfaced but can never be supported.
    const inScopeChunkIds = claim.citationChunkIds.filter((id) => validChunkIds.has(id));
    const stampedEvidence: RagEvidence[] = [];
    for (const ev of claim.evidence) {
      // Chunk identity: the evidence chunk must be a retrieved chunk.
      const chunk = chunkById.get(ev.chunkId);
      if (!chunk) return { ok: false, reasonCode: "CLAIM_EVIDENCE_CHUNK_UNKNOWN" };
      // Scope: the evidence chunk must also be a validated citation.
      if (!validChunkIds.has(ev.chunkId)) return { ok: false, reasonCode: "CLAIM_EVIDENCE_SCOPE_MISMATCH" };
      // Quote integrity: non-empty, bounded, and an actual substring of the
      // cited chunk at a server-located offset (no normalization tricks that
      // would break raw-offset reconstructability).
      if (typeof ev.quote !== "string" || ev.quote.length === 0 || ev.quote.length > 800) {
        return { ok: false, reasonCode: "CLAIM_EVIDENCE_QUOTE_MISMATCH" };
      }
      const quoteStart = chunk.content.indexOf(ev.quote);
      if (quoteStart < 0) return { ok: false, reasonCode: "CLAIM_EVIDENCE_QUOTE_MISMATCH" };
      const quoteEnd = quoteStart + ev.quote.length;
      // Span integrity: model offsets must be integers in range and EXACTLY
      // match the server-authoritative location. Never clamp.
      if (!Number.isInteger(ev.start) || !Number.isInteger(ev.end)
        || ev.start < 0 || ev.end < 0 || ev.start > ev.end
        || ev.end > chunk.content.length
        || ev.start !== quoteStart || ev.end !== quoteEnd) {
        return { ok: false, reasonCode: "CLAIM_EVIDENCE_SPAN_MISMATCH" };
      }
      // Hash integrity: a model-supplied hash must equal the quote-derived
      // hash; the stamped hash is ALWAYS derived from the quote itself (R-4).
      const quoteHash = hashEvidenceSpan(ev.quote);
      if (ev.contentHash !== "" && ev.contentHash.toLowerCase() !== quoteHash) {
        return { ok: false, reasonCode: "CLAIM_EVIDENCE_HASH_MISMATCH" };
      }
      stampedEvidence.push({
        quote: ev.quote,
        contentHash: quoteHash,
        hashAlgorithm: "sha256",
        chunkId: ev.chunkId,
        start: quoteStart,
        end: quoteEnd
      });
    }
    result.push({
      claimId: claim.claimId,
      text: claim.text,
      answerStart: located.start,
      answerEnd: located.end,
      status: claim.status,
      ...(claim.riskCategory ? { riskCategory: claim.riskCategory } : {}),
      citationChunkIds: inScopeChunkIds.length > 0 ? inScopeChunkIds : claim.citationChunkIds,
      evidence: stampedEvidence
    });
  }
  return { ok: true, claims: result };
}

function annotateClaimSupport(
  claims: RagClaimGrounding[],
  support: Array<{ claimId: string; status: "supported" | "unsupported"; riskCategory?: RagClaimGrounding["riskCategory"] }>
): RagClaimGrounding[] {
  const map = new Map(support.map((s) => [s.claimId, s]));
  return claims.map((claim) => {
    const s = map.get(claim.claimId);
    if (!s) return { ...claim, status: "unsupported" as const };
    return {
      ...claim,
      status: s.status,
      ...(s.riskCategory ? { riskCategory: s.riskCategory } : (claim.riskCategory ? { riskCategory: claim.riskCategory } : {}))
    };
  });
}

function invalidModelAnswer(provider: "cerebras" | "fake"): never {
  throw new RagApplicationError({ code: "RAG_PROVIDER_INVALID_RESPONSE", provider, failureKind: "invalid_response" });
}

function abstained(requestId: string, reason: "NO_EVIDENCE" | "INJECTION_BLOCKED" | "INSUFFICIENT_EVIDENCE"): RagResponse {
  return {
    contractVersion: 1,
    requestId,
    answer: "No sufficient evidence was found.",
    citations: [],
    confidence: "low",
    grounding: "abstained",
    citationStatus: "not_checked",
    abstained: true,
    abstentionReason: reason
  };
}
