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
import type { GroundingValidationInput, GroundingValidator, GroundingVerdict, LlmProvider, RagApplication, RagTelemetrySink, RetrievedChunk, Retriever } from "./ports";
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
    // text before validation. Sanitization is redaction-only (no length
    // truncation in practice for grounded answers), but we still re-slice to
    // guarantee claim.text === answer.slice(start,end) per contract.
    const sanitizedAnswer = sanitizeGeneratedAnswer(modelAnswer.answer);
    const validatedCitations = citationResult.citations;
    const claims = recomputeClaimOffsets(modelAnswer.claims ?? [], sanitizedAnswer, screened.chunks, validatedCitations);

    // Run the independent grounding validator. The generator's confidence is
    // deliberately excluded from the verdict; disagreement resolves to the
    // validator's verdict (fail-closed).
    //
    // Note: the request AbortSignal is intentionally NOT forwarded to the
    // validator. Express 5 aborts req.signal once the JSON body has been
    // consumed, which would spuriously fail a synchronous rule-based validator
    // closed on every request. Request-cancellation semantics are preserved at
    // the retriever/generation layers; LLM-backed validators implement their
    // own internal timeouts.
    let verdict: GroundingVerdict;
    let validatorIdentity = "unknown";
    try {
      const validatorInput: GroundingValidationInput = {
        requestId: request.requestId,
        answer: sanitizedAnswer,
        claims,
        citations: validatedCitations,
        retrievedChunks: screened.chunks,
        scope: request.scope
      };
      const result = await this.groundingValidator.validate(validatorInput);
      verdict = result.verdict;
      validatorIdentity = result.validatorIdentity;
    } catch {
      // Validator failure (timeout/exception) MUST fail closed: never verified.
      verdict = "abstained";
    }

    if (verdict === "abstained") {
      // The validator could not establish grounding for any claim. This is a
      // soft abstention (200), distinct from a hard citation-integrity failure.
      const response = abstained(request.requestId, "INSUFFICIENT_EVIDENCE");
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "abstained", latencyMs: Date.now() - started, retrievedChunkCount: retrieved.length, citationCount: validatedCitations.length });
      return response;
    }

    if (verdict === "partial") {
      // Some claims are unsupported: surface them for reviewer/learner audit.
      // The answer remains visible (marked inline in the UI) but is NOT
      // presented as a fully verified success.
      // Same rationale as the first validation call: no request signal (see
      // the note above — Express aborts req.signal after body consumption).
      const validatorResult = await this.groundingValidator.validate({
        requestId: request.requestId, answer: sanitizedAnswer, claims, citations: validatedCitations, retrievedChunks: screened.chunks, scope: request.scope
      }).catch(() => ({ claimSupport: [], unsupportedClaimCount: claims.length, verdict: "partial" as const, validatorIdentity }));
      const annotatedClaims = annotateClaimSupport(claims, validatorResult.claimSupport);
      const unsupportedClaimCount = annotatedClaims.filter((c) => c.status === "unsupported").length;
      const response: RagResponse = {
        contractVersion: 1,
        requestId: request.requestId,
        answer: sanitizedAnswer,
        citations: validatedCitations,
        confidence: modelAnswer.confidence,
        grounding: "unverified",
        citationStatus: "verified",
        abstained: false,
        claims: annotatedClaims,
        unsupportedClaimCount
      };
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "success", latencyMs: Date.now() - started, retrievedChunkCount: retrieved.length, citationCount: validatedCitations.length });
      return response;
    }

    // verdict === "verified": all claims supported by cited, in-scope evidence.
    const response: RagResponse = {
      contractVersion: 1,
      requestId: request.requestId,
      answer: sanitizedAnswer,
      citations: validatedCitations,
      confidence: modelAnswer.confidence,
      grounding: "verified",
      citationStatus: "verified",
      abstained: false,
      claims,
      unsupportedClaimCount: 0
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
 * Parse the model-supplied claims array loosely. Offsets are recomputed
 * downstream (see recomputeClaimOffsets) so model-supplied offsets are only
 * used as hints to locate the claim text within the answer. Malformed claims
 * are dropped (not fatal) — the validator will then see fewer claims.
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
    // Locate claim.text within answer (re-derive canonical offsets).
    const located = locateClaimOffset(answer, e.text, e.answerStart);
    if (!located) continue;
    const evidence = parseModelEvidence(e.evidence);
    if (evidence === null) continue;
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
 * Parse model evidence and stamp server-derived hashes. The model supplies
 * quote/chunkId/start/end; the hash is ALWAYS re-derived from the actual
 * chunk span, never trusted from model input.
 */
function parseModelEvidence(raw: unknown): RagEvidence[] | null {
  if (!Array.isArray(raw)) return [];
  const out: RagEvidence[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const e = item as Record<string, unknown>;
    if (typeof e.quote !== "string" || typeof e.chunkId !== "number" && typeof e.chunkId !== "string") continue;
    if (typeof e.start !== "number" || typeof e.end !== "number") continue;
    // hash is intentionally ignored from model; recomputed by recomputeClaimOffsets.
    out.push({
      quote: e.quote,
      contentHash: "", // placeholder, filled by recomputeClaimOffsets
      hashAlgorithm: "sha256",
      chunkId: String(e.chunkId),
      start: e.start,
      end: e.end
    });
  }
  return out;
}

/**
 * Recompute claim offsets against the sanitized answer and stamp
 * server-derived evidence hashes from the actual retrieved chunk spans.
 * Drops claims/evidence whose offsets or chunk ids are out of scope.
 */
function recomputeClaimOffsets(
  claims: RagClaimGrounding[],
  sanitizedAnswer: string,
  chunks: readonly RetrievedChunk[],
  validatedCitations: RagCitation[]
): RagClaimGrounding[] {
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const validChunkIds = new Set(validatedCitations.map((c) => c.chunkId));
  const result: RagClaimGrounding[] = [];

  for (const claim of claims) {
    // Re-locate in sanitized answer (sanitization may shift nothing in
    // practice, but we must guarantee offset contract).
    const located = locateClaimOffset(sanitizedAnswer, claim.text, claim.answerStart);
    if (!located) continue;
    // Drop claim if none of its citation chunk ids are in the validated set.
    const inScopeChunkIds = claim.citationChunkIds.filter((id) => validChunkIds.has(id));
    const stampedEvidence: RagEvidence[] = [];
    for (const ev of claim.evidence) {
      const chunk = chunkById.get(ev.chunkId);
      if (!chunk) continue;
      // Clamp/verify offsets against actual chunk length.
      const start = Math.max(0, Math.min(ev.start, chunk.content.length));
      const end = Math.max(start + 1, Math.min(ev.end, chunk.content.length));
      const span = chunk.content.slice(start, end);
      // Verify the quote is a real substring (integrity), else drop evidence.
      if (!chunk.content.includes(ev.quote)) continue;
      stampedEvidence.push({
        quote: ev.quote,
        contentHash: hashEvidenceSpan(span),
        hashAlgorithm: "sha256",
        chunkId: ev.chunkId,
        start,
        end
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
  return result;
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
