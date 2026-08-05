import { z } from "zod";

/**
 * Student RAG wire contracts (browser-safe DTOs + strict runtime schemas).
 *
 * `scope` is NEVER supplied by the browser: the Student API derives it from
 * the server session plus the route parameter. It is part of the wire
 * vocabulary because it travels server -> retriever, not because clients
 * may send it.
 */

export const studentRagScopeV1Schema = z.object({
  studentId: z.string().min(1).max(128),
  bookId: z.string().min(1).max(128),
  institutionId: z.string().min(1).max(128).optional()
}).strict();
export type StudentRagScopeV1 = z.infer<typeof studentRagScopeV1Schema>;

/** Public request body of POST /api/student/books/:bookId/rag-ask. */
export const studentRagAskRequestV1Schema = z.object({
  contractVersion: z.literal(1).optional(),
  query: z.string().trim().min(1).max(4_000),
  conversationId: z.string().min(1).max(128).optional()
}).strict();
export type StudentRagAskRequestV1 = z.infer<typeof studentRagAskRequestV1Schema>;

export const studentRagCitationV1Schema = z.object({
  chunkId: z.string().min(1).max(128),
  label: z.string().min(1).max(240),
  locator: z.string().max(240).optional(),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional()
}).strict();
export type StudentRagCitationV1 = z.infer<typeof studentRagCitationV1Schema>;

export const studentRagConfidenceV1Schema = z.enum(["high", "medium", "low"]);
export type StudentRagConfidenceV1 = z.infer<typeof studentRagConfidenceV1Schema>;
export const studentRagGroundingV1Schema = z.enum(["verified", "unverified", "abstained"]);
export type StudentRagGroundingV1 = z.infer<typeof studentRagGroundingV1Schema>;
export const studentRagAbstentionReasonV1Schema = z.enum([
  "NO_EVIDENCE",
  "INJECTION_BLOCKED",
  "INSUFFICIENT_EVIDENCE"
]);
export type StudentRagAbstentionReasonV1 = z.infer<typeof studentRagAbstentionReasonV1Schema>;

/** Public success body of POST /api/student/books/:bookId/rag-ask. */
export const studentRagAskResponseV1Schema = z.object({
  contractVersion: z.literal(1),
  requestId: z.string().min(1).max(200),
  answer: z.string().min(1).max(20_000),
  citations: z.array(studentRagCitationV1Schema).max(20),
  confidence: studentRagConfidenceV1Schema,
  grounding: studentRagGroundingV1Schema,
  citationStatus: z.enum(["verified", "not_checked", "invalid"]),
  abstained: z.boolean(),
  abstentionReason: studentRagAbstentionReasonV1Schema.optional()
}).strict();
export type StudentRagAskResponseV1 = z.infer<typeof studentRagAskResponseV1Schema>;

export const studentRagErrorCodeV1Schema = z.enum([
  "RAG_INVALID_REQUEST",
  "RAG_INJECTION_BLOCKED",
  "RAG_NO_EVIDENCE",
  "RAG_CITATION_INVALID",
  "RAG_PROVIDER_TIMEOUT",
  "RAG_PROVIDER_RATE_LIMITED",
  "RAG_PROVIDER_INVALID_RESPONSE",
  "RAG_PROVIDER_AUTH_FAILED",
  "RAG_PROVIDER_UNAVAILABLE",
  "RAG_INTERNAL"
]);
export type StudentRagErrorCodeV1 = z.infer<typeof studentRagErrorCodeV1Schema>;

/** Public error body of POST /api/student/books/:bookId/rag-ask. */
export const studentRagAskErrorV1Schema = z.object({
  contractVersion: z.literal(1),
  requestId: z.string().min(1).max(200).optional(),
  error: z.object({
    code: studentRagErrorCodeV1Schema,
    message: z.string().min(1),
    retryable: z.boolean()
  }).strict()
}).strict();
export type StudentRagAskErrorV1 = z.infer<typeof studentRagAskErrorV1Schema>;
