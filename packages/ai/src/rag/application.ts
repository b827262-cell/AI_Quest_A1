import { randomUUID } from "node:crypto";
import {
  parseRagRequest,
  type RagCitation,
  type RagRequest,
  type RagResponse
} from "./contracts";
import { RagApplicationError, asRagApplicationError } from "./errors";
import { citationFailureReason, validateCitations } from "./citation-validator";
import { screenPromptInjection, screenRetrievedChunks } from "./injection-screening";
import { buildRagPrompt, RAG_SYSTEM_PROMPT, sanitizeGeneratedAnswer } from "./prompt-builder";
import type { LlmProvider, RagApplication, RagTelemetrySink, RetrievedChunk, Retriever } from "./ports";
import { NoopRagTelemetrySink } from "./ports";

export type RagApplicationOptions = {
  retriever: Retriever;
  provider: LlmProvider;
  telemetry?: RagTelemetrySink;
  idFactory?: () => string;
};

export class RagApplicationService implements RagApplication {
  private readonly retriever: Retriever;
  private readonly provider: LlmProvider;
  private readonly telemetry: RagTelemetrySink;
  private readonly idFactory: () => string;

  constructor(options: RagApplicationOptions) {
    this.retriever = options.retriever;
    this.provider = options.provider;
    this.telemetry = options.telemetry ?? new NoopRagTelemetrySink();
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async answer(input: RagRequest | unknown, signal?: AbortSignal): Promise<RagResponse> {
    const request = parseRequest(input, this.idFactory);
    const started = Date.now();
    const userScreening = screenPromptInjection(request.query, "user");
    if (userScreening.decision === "block") {
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "error", latencyMs: Date.now() - started, retrievedChunkCount: 0, citationCount: 0, errorCode: "RAG_INJECTION_BLOCKED" });
      throw new RagApplicationError({ code: "RAG_INJECTION_BLOCKED", reasonCode: userScreening.reasonCode });
    }

    let retrieved: readonly RetrievedChunk[];
    try {
      retrieved = await this.retriever.retrieve({ requestId: request.requestId, query: request.query, topK: request.topK, signal });
    } catch {
      await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "error", latencyMs: Date.now() - started, retrievedChunkCount: 0, citationCount: 0, errorCode: "RAG_INTERNAL" });
      throw new RagApplicationError({ code: "RAG_INTERNAL" });
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

    let modelAnswer: { answer: string; citations: RagCitation[]; confidence: "high" | "medium" | "low" };
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

    const response: RagResponse = {
      contractVersion: 1,
      requestId: request.requestId,
      answer: sanitizeGeneratedAnswer(modelAnswer.answer),
      citations: citationResult.citations,
      confidence: modelAnswer.confidence,
      grounding: "verified",
      citationStatus: "verified",
      abstained: false
    };
    await this.record({ requestId: request.requestId, provider: this.provider.providerId, status: "success", latencyMs: Date.now() - started, retrievedChunkCount: retrieved.length, citationCount: response.citations.length });
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

function parseModelAnswer(text: string, provider: "cerebras" | "fake"): { answer: string; citations: RagCitation[]; confidence: "high" | "medium" | "low" } {
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
  return { answer: object.answer, citations: object.citations as RagCitation[], confidence: object.confidence as "high" | "medium" | "low" };
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
