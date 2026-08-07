/**
 * Browser-safe RAG wire contracts.
 *
 * These contracts deliberately contain no provider, credential, database or
 * HTTP-framework types.  The small schema facade keeps runtime validation
 * available to routes without making the server implementation part of the
 * browser entry point.
 */

export const RAG_CONTRACT_VERSION = 1 as const;

export type RagConfidence = "high" | "medium" | "low";
export type RagGrounding = "verified" | "unverified" | "abstained";

export type RagErrorCode =
  | "RAG_INVALID_REQUEST"
  | "RAG_INJECTION_BLOCKED"
  | "RAG_NO_EVIDENCE"
  | "RAG_CITATION_INVALID"
  | "RAG_PROVIDER_TIMEOUT"
  | "RAG_PROVIDER_RATE_LIMITED"
  | "RAG_PROVIDER_INVALID_RESPONSE"
  | "RAG_PROVIDER_AUTH_FAILED"
  | "RAG_PROVIDER_UNAVAILABLE"
  | "RAG_INTERNAL";

export const RAG_ERROR_HTTP_STATUS: Readonly<Record<RagErrorCode, number>> = {
  RAG_INVALID_REQUEST: 400,
  RAG_INJECTION_BLOCKED: 400,
  RAG_NO_EVIDENCE: 200,
  RAG_CITATION_INVALID: 502,
  RAG_PROVIDER_TIMEOUT: 504,
  RAG_PROVIDER_RATE_LIMITED: 429,
  RAG_PROVIDER_INVALID_RESPONSE: 502,
  RAG_PROVIDER_AUTH_FAILED: 503,
  RAG_PROVIDER_UNAVAILABLE: 503,
  RAG_INTERNAL: 500
};

/**
 * Retrieval authorization scope. Always derived server-side from the student
 * session and the route parameter; browsers may never supply or override it.
 */
export type RagScope = {
  studentId: string;
  bookId: string;
  institutionId?: string;
};

export type RagRequest = {
  contractVersion: typeof RAG_CONTRACT_VERSION;
  requestId: string;
  query: string;
  topK: number;
  maxOutputTokens: number;
  scope: RagScope;
};

export type RagCitation = {
  chunkId: string;
  label: string;
  locator?: string;
  start?: number;
  end?: number;
  evidenceQuote?: string;
  contentHash?: string;
  hashAlgorithm?: "sha256";
};

export type RagEvidence = {
  quote: string;
  contentHash: string;
  hashAlgorithm: "sha256";
  chunkId: string;
  start: number;
  end: number;
};

export type RagClaimStatus = "supported" | "unsupported";

export type RagClaimRiskCategory = "general" | "number" | "date" | "formula" | "proper_noun";

export type RagClaimGrounding = {
  claimId: string;
  text: string;
  answerStart: number;
  answerEnd: number;
  status: RagClaimStatus;
  riskCategory?: RagClaimRiskCategory;
  citationChunkIds: string[];
  evidence: RagEvidence[];
};

export type RagResponse = {
  contractVersion: typeof RAG_CONTRACT_VERSION;
  requestId: string;
  answer: string;
  citations: RagCitation[];
  confidence: RagConfidence;
  grounding: RagGrounding;
  citationStatus: "verified" | "not_checked" | "invalid";
  abstained: boolean;
  abstentionReason?: "NO_EVIDENCE" | "INJECTION_BLOCKED" | "INSUFFICIENT_EVIDENCE";
  claims?: RagClaimGrounding[];
  unsupportedClaimCount?: number;
};

export type RagErrorResponse = {
  contractVersion: typeof RAG_CONTRACT_VERSION;
  requestId?: string;
  error: {
    code: RagErrorCode;
    message: string;
    retryable: boolean;
  };
};

export type RagSchemaResult<T> =
  | { success: true; data: T }
  | { success: false; error: RagContractValidationError };

export class RagContractValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("RAG contract validation failed");
    this.name = "RagContractValidationError";
    this.issues = [...issues];
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rejectUnknownKeys(object: Record<string, unknown>, allowed: readonly string[], issues: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) issues.push(`${key}_unknown`);
  }
}

function requiredString(value: unknown, field: string, maxLength: number, issues: string[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    issues.push(`${field}_invalid`);
    return undefined;
  }
  return value.trim();
}

function boundedInteger(value: unknown, field: string, min: number, max: number, issues: string[]): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    issues.push(`${field}_invalid`);
    return undefined;
  }
  return value;
}

function parseCitation(value: unknown, index: number): RagCitation | undefined {
  const issues: string[] = [];
  const object = recordValue(value);
  if (!object) {
    issues.push(`citations_${index}_format_invalid`);
  } else {
    rejectUnknownKeys(object, ["chunkId", "label", "locator", "start", "end", "evidenceQuote", "contentHash", "hashAlgorithm"], issues);
  }
  const chunkId = object ? requiredString(object.chunkId, `citations_${index}_chunk_id`, 128, issues) : undefined;
  const label = object ? requiredString(object.label, `citations_${index}_label`, 240, issues) : undefined;
  const locator = object?.locator === undefined
    ? undefined
    : requiredString(object.locator, `citations_${index}_locator`, 240, issues);
  const start = object?.start === undefined
    ? undefined
    : boundedInteger(object.start, `citations_${index}_start`, 0, Number.MAX_SAFE_INTEGER, issues);
  const end = object?.end === undefined
    ? undefined
    : boundedInteger(object.end, `citations_${index}_end`, 0, Number.MAX_SAFE_INTEGER, issues);
  const evidenceQuote = object?.evidenceQuote === undefined
    ? undefined
    : requiredString(object.evidenceQuote, `citations_${index}_evidence_quote`, 800, issues);
  const contentHash = object?.contentHash === undefined
    ? undefined
    : (typeof object.contentHash === "string" && /^[a-f0-9]{64}$/.test(object.contentHash)
      ? object.contentHash
      : (issues.push(`citations_${index}_content_hash_invalid`), undefined));
  const hashAlgorithm = object?.hashAlgorithm === undefined
    ? undefined
    : (object.hashAlgorithm === "sha256" ? "sha256" : (issues.push(`citations_${index}_hash_algorithm_invalid`), undefined));
  if (issues.length > 0) return undefined;
  return { chunkId: chunkId!, label: label!, locator, start, end, evidenceQuote, contentHash, hashAlgorithm };
}

function parseEvidence(value: unknown, prefix: string): RagEvidence | undefined {
  const issues: string[] = [];
  const object = recordValue(value);
  if (!object) {
    issues.push(`${prefix}_format_invalid`);
  } else {
    rejectUnknownKeys(object, ["quote", "contentHash", "hashAlgorithm", "chunkId", "start", "end"], issues);
  }
  const quote = object ? requiredString(object.quote, `${prefix}_quote`, 800, issues) : undefined;
  const contentHash = object?.contentHash === undefined
    ? undefined
    : (typeof object.contentHash === "string" && /^[a-f0-9]{64}$/.test(object.contentHash)
      ? object.contentHash
      : (issues.push(`${prefix}_content_hash_invalid`), undefined));
  if (object?.hashAlgorithm !== undefined && object.hashAlgorithm !== "sha256") {
    issues.push(`${prefix}_hash_algorithm_invalid`);
  }
  const chunkId = object ? requiredString(object.chunkId, `${prefix}_chunk_id`, 128, issues) : undefined;
  const start = object?.start === undefined
    ? undefined
    : boundedInteger(object.start, `${prefix}_start`, 0, Number.MAX_SAFE_INTEGER, issues);
  const end = object?.end === undefined
    ? undefined
    : boundedInteger(object.end, `${prefix}_end`, 1, Number.MAX_SAFE_INTEGER, issues);
  if (issues.length > 0) return undefined;
  return {
    quote: quote!,
    contentHash: contentHash!,
    hashAlgorithm: "sha256",
    chunkId: chunkId!,
    start: start!,
    end: end!
  };
}

function parseClaimGrounding(value: unknown, index: number, answer: string): RagClaimGrounding | undefined {
  const issues: string[] = [];
  const object = recordValue(value);
  if (!object) {
    issues.push(`claims_${index}_format_invalid`);
  } else {
    rejectUnknownKeys(object, ["claimId", "text", "answerStart", "answerEnd", "status", "riskCategory", "citationChunkIds", "evidence"], issues);
  }
  const claimId = object ? requiredString(object.claimId, `claims_${index}_claim_id`, 128, issues) : undefined;
  const text = object ? requiredString(object.text, `claims_${index}_text`, 2_000, issues) : undefined;
  const answerStart = object?.answerStart === undefined
    ? undefined
    : boundedInteger(object.answerStart, `claims_${index}_answer_start`, 0, Number.MAX_SAFE_INTEGER, issues);
  const answerEnd = object?.answerEnd === undefined
    ? undefined
    : boundedInteger(object.answerEnd, `claims_${index}_answer_end`, 1, Number.MAX_SAFE_INTEGER, issues);
  if (!["supported", "unsupported"].includes(String(object?.status))) {
    issues.push(`claims_${index}_status_invalid`);
  }
  const validRiskCategories = ["general", "number", "date", "formula", "proper_noun"];
  if (object?.riskCategory !== undefined && !validRiskCategories.includes(String(object.riskCategory))) {
    issues.push(`claims_${index}_risk_category_invalid`);
  }
  if (!Array.isArray(object?.citationChunkIds)) {
    issues.push(`claims_${index}_citation_chunk_ids_invalid`);
  }
  if (issues.length > 0) return undefined;
  // Offset invariant: UTF-16 code-unit offsets must slice to the claim text.
  if (answerStart === undefined || answerEnd === undefined || answerStart >= answerEnd || answerEnd > answer.length) {
    issues.push(`claims_${index}_offset_out_of_bounds`);
    return undefined;
  }
  const sliced = answer.slice(answerStart, answerEnd);
  if (sliced !== text) {
    issues.push(`claims_${index}_text_offset_mismatch`);
    return undefined;
  }
  const citationChunkIds = (object!.citationChunkIds as unknown[]).map((id, ci) => {
    const sid = requiredString(id, `claims_${index}_citation_chunk_ids_${ci}`, 128, issues);
    return sid;
  });
  const evidenceValue = object!.evidence;
  const evidence: RagEvidence[] = [];
  if (!Array.isArray(evidenceValue) || evidenceValue.length > 10) {
    issues.push(`claims_${index}_evidence_invalid`);
  } else {
    evidenceValue.forEach((ev, ei) => {
      const parsed = parseEvidence(ev, `claims_${index}_evidence_${ei}`);
      if (parsed) evidence.push(parsed);
      else issues.push(`claims_${index}_evidence_${ei}_invalid`);
    });
  }
  if (issues.length > 0) return undefined;
  const riskCategory = object!.riskCategory !== undefined
    ? object!.riskCategory as RagClaimRiskCategory
    : undefined;
  return {
    claimId: claimId!,
    text: text!,
    answerStart: answerStart!,
    answerEnd: answerEnd!,
    status: object!.status as RagClaimStatus,
    ...(riskCategory !== undefined ? { riskCategory } : {}),
    citationChunkIds: citationChunkIds as string[],
    evidence
  };
}

function parseRagScope(value: unknown, issues: string[]): RagScope | undefined {
  const object = recordValue(value);
  if (!object) {
    issues.push("scope_invalid");
    return undefined;
  }
  rejectUnknownKeys(object, ["studentId", "bookId", "institutionId"], issues);
  const studentId = requiredString(object.studentId, "scope_student_id", 128, issues);
  const bookId = requiredString(object.bookId, "scope_book_id", 128, issues);
  const institutionId = object.institutionId === undefined
    ? undefined
    : requiredString(object.institutionId, "scope_institution_id", 128, issues);
  if (!studentId || !bookId) return undefined;
  return institutionId === undefined ? { studentId, bookId } : { studentId, bookId, institutionId };
}

export function parseRagRequest(value: unknown): RagRequest {
  const issues: string[] = [];
  const object = recordValue(value);
  if (!object) throw new RagContractValidationError(["request_format_invalid"]);
  rejectUnknownKeys(object, ["contractVersion", "requestId", "query", "topK", "maxOutputTokens", "scope"], issues);
  if (object.contractVersion !== RAG_CONTRACT_VERSION) issues.push("contract_version_invalid");
  const requestId = requiredString(object.requestId, "request_id", 200, issues);
  const query = requiredString(object.query, "query", 8_000, issues);
  const topK = object.topK === undefined ? 6 : boundedInteger(object.topK, "top_k", 1, 20, issues);
  const maxOutputTokens = object.maxOutputTokens === undefined
    ? 1_024
    : boundedInteger(object.maxOutputTokens, "max_output_tokens", 1, 8_192, issues);
  // Scope is mandatory: retrieval without an authorization scope must fail closed.
  const scope = parseRagScope(object.scope, issues);
  if (issues.length > 0 || !scope) throw new RagContractValidationError(issues.length > 0 ? issues : ["scope_invalid"]);
  return {
    contractVersion: RAG_CONTRACT_VERSION,
    requestId: requestId!,
    query: query!,
    topK: topK!,
    maxOutputTokens: maxOutputTokens!,
    scope
  };
}

export function parseRagResponse(value: unknown): RagResponse {
  const issues: string[] = [];
  const object = recordValue(value);
  if (!object) throw new RagContractValidationError(["response_format_invalid"]);
  rejectUnknownKeys(object, ["contractVersion", "requestId", "answer", "citations", "confidence", "grounding", "citationStatus", "abstained", "abstentionReason", "claims", "unsupportedClaimCount"], issues);
  if (object.contractVersion !== RAG_CONTRACT_VERSION) issues.push("contract_version_invalid");
  const requestId = requiredString(object.requestId, "request_id", 200, issues);
  const answer = typeof object.answer === "string" && object.answer.trim().length > 0 && object.answer.length <= 20_000
    ? object.answer
    : (issues.push("answer_invalid"), undefined);
  const citationsValue = object.citations;
  const citations: RagCitation[] = [];
  if (!Array.isArray(citationsValue) || citationsValue.length > 20) {
    issues.push("citations_format_invalid");
  } else {
    citationsValue.forEach((citation, index) => {
      const parsed = parseCitation(citation, index);
      if (parsed) citations.push(parsed);
      else issues.push(`citations_${index}_invalid`);
    });
  }
  if (!(["high", "medium", "low"] as readonly unknown[]).includes(object.confidence)) {
    issues.push("confidence_invalid");
  }
  if (!(["verified", "unverified", "abstained"] as readonly unknown[]).includes(object.grounding)) {
    issues.push("grounding_invalid");
  }
  if (!["verified", "not_checked", "invalid"].includes(String(object.citationStatus))) {
    issues.push("citation_status_invalid");
  }
  if (typeof object.abstained !== "boolean") issues.push("abstained_invalid");
  if (object.grounding === "verified"
    && (object.citationStatus !== "verified" || citations.length === 0 || object.abstained !== false)) {
    issues.push("verified_requires_checked_citations");
  }
  if (object.grounding === "abstained" && object.abstained !== true) {
    issues.push("abstained_grounding_requires_abstained_flag");
  }
  // Parse optional claims array with per-claim offset invariants.
  const claimsValue = object.claims;
  const claims: RagClaimGrounding[] = [];
  if (claimsValue !== undefined) {
    if (!Array.isArray(claimsValue) || claimsValue.length > 100) {
      issues.push("claims_format_invalid");
    } else {
      claimsValue.forEach((claim, index) => {
        const parsed = answer !== undefined ? parseClaimGrounding(claim, index, answer) : undefined;
        if (parsed) claims.push(parsed);
        else issues.push(`claims_${index}_invalid`);
      });
    }
  }
  // unsupportedClaimCount consistency.
  if (object.unsupportedClaimCount !== undefined) {
    if (typeof object.unsupportedClaimCount !== "number" || !Number.isInteger(object.unsupportedClaimCount) || object.unsupportedClaimCount < 0) {
      issues.push("unsupported_claim_count_invalid");
    }
  }
  // verified grounding must have zero unsupported claims.
  if (object.grounding === "verified" && claims.length > 0) {
    const unsupported = claims.filter((c) => c.status === "unsupported").length;
    if (unsupported > 0) issues.push("verified_requires_all_claims_supported");
  }
  // unsupportedClaimCount must match the actual count when both are present.
  if (typeof object.unsupportedClaimCount === "number" && claims.length > 0) {
    const actual = claims.filter((c) => c.status === "unsupported").length;
    if (actual !== object.unsupportedClaimCount) issues.push("unsupported_claim_count_mismatch");
  }
  if (issues.length > 0) throw new RagContractValidationError(issues);
  const response: RagResponse = {
    contractVersion: RAG_CONTRACT_VERSION,
    requestId: requestId!,
    answer: answer!,
    citations,
    confidence: object.confidence as RagConfidence,
    grounding: object.grounding as RagGrounding,
    citationStatus: object.citationStatus as RagResponse["citationStatus"],
    abstained: object.abstained as boolean,
    ...(claims.length > 0 ? { claims } : {}),
    ...(object.unsupportedClaimCount !== undefined ? { unsupportedClaimCount: object.unsupportedClaimCount as number } : {})
  };
  if (typeof object.abstentionReason === "string") {
    if (!["NO_EVIDENCE", "INJECTION_BLOCKED", "INSUFFICIENT_EVIDENCE"].includes(object.abstentionReason)) {
      throw new RagContractValidationError(["abstention_reason_invalid"]);
    }
    response.abstentionReason = object.abstentionReason as NonNullable<RagResponse["abstentionReason"]>;
  }
  return response;
}

export function parseRagErrorResponse(value: unknown): RagErrorResponse {
  const object = recordValue(value);
  const error = object ? recordValue(object.error) : null;
  const code = error?.code;
  const knownCodes: readonly RagErrorCode[] = [
    "RAG_INVALID_REQUEST", "RAG_INJECTION_BLOCKED", "RAG_NO_EVIDENCE", "RAG_CITATION_INVALID",
    "RAG_PROVIDER_TIMEOUT", "RAG_PROVIDER_RATE_LIMITED", "RAG_PROVIDER_INVALID_RESPONSE",
    "RAG_PROVIDER_AUTH_FAILED", "RAG_PROVIDER_UNAVAILABLE", "RAG_INTERNAL"
  ];
  const issues: string[] = [];
  if (object) rejectUnknownKeys(object, ["contractVersion", "requestId", "error"], issues);
  if (error) rejectUnknownKeys(error, ["code", "message", "retryable"], issues);
  if (!object || object.contractVersion !== RAG_CONTRACT_VERSION || !error || issues.length > 0
    || typeof code !== "string" || !knownCodes.includes(code as RagErrorCode)
    || typeof error.message !== "string" || error.message.length > 300
    || typeof error.retryable !== "boolean") {
    throw new RagContractValidationError(["error_response_invalid"]);
  }
  const requestIdIssues: string[] = [];
  const requestId = object.requestId === undefined
    ? undefined
    : requiredString(object.requestId, "request_id", 200, requestIdIssues);
  if (requestIdIssues.length > 0) throw new RagContractValidationError(requestIdIssues);
  return {
    contractVersion: RAG_CONTRACT_VERSION,
    requestId,
    error: { code: code as RagErrorCode, message: error.message, retryable: error.retryable }
  };
}

function schema<T>(parse: (value: unknown) => T) {
  return {
    parse,
    safeParse(value: unknown): RagSchemaResult<T> {
      try {
        return { success: true, data: parse(value) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof RagContractValidationError
            ? error
            : new RagContractValidationError(["contract_invalid"])
        };
      }
    }
  } as const;
}

export const ragRequestSchema = schema(parseRagRequest);
export const ragResponseSchema = schema(parseRagResponse);
export const ragErrorResponseSchema = schema(parseRagErrorResponse);
