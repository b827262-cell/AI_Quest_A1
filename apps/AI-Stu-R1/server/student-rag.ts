import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { studentRagAskRequestV1Schema } from "@ai-smartbook/contracts";
import {
  CerebrasLlmProvider,
  FakeLlmProvider,
  RagApplicationError,
  RagApplicationService,
  RuleBasedGroundingValidator,
  asRagApplicationError,
  hashEvidenceSpan,
  type LlmGenerateInput,
  type LlmProvider,
  type RagScope,
  type Retriever,
  type RetrieverInput,
  type RetrievedChunk
} from "@ai-smartbook/ai/rag/server";
import type { StudentDataSource } from "@ai-smartbook/student-runtime";

/**
 * Scoped student RAG route.
 *
 * Processing order (server-enforced, never trusted from the browser):
 *   session (mounted middleware) -> profile (mounted middleware)
 *   -> book access check -> retriever scope -> injection screening
 *   -> retrieval -> generation -> citation validation -> contract response.
 *
 * The route only orchestrates: prompt building, retrieval policy and
 * citation validation stay inside RagApplicationService.
 */

export type StudentRagEnv = {
  /** "cerebras" (default when a key exists), "fake" for deterministic tests. */
  provider?: string;
  cerebrasApiKey?: string;
  cerebrasBaseUrl?: string;
  cerebrasModel?: string;
  /**
   * Deterministic failure injection for smoke gates (fake provider only):
   *   grounded            — fully grounded answer with claims + evidence
   *   invalid_citation    — fabricates a chunkId never retrieved (hard fail)
   *   weak_source         — cites a chunk but answer text barely overlaps
   *   partial_unsupported — supported claim + one unsupported general claim
   *   unsupported_number  — supported context + unsupported numeric claim
   *   evidence_quote_tamper — quote that is not a chunk substring (hard fail)
   */
  fakeMode?: "grounded" | "invalid_citation" | "weak_source" | "partial_unsupported" | "unsupported_number" | "evidence_quote_tamper";
};

const VALID_FAKE_MODES = new Set<string>([
  "grounded", "invalid_citation", "weak_source", "partial_unsupported", "unsupported_number", "evidence_quote_tamper"
]);

export function resolveStudentRagEnv(env: NodeJS.ProcessEnv = process.env): StudentRagEnv {
  const fakeMode = env.STUDENT_RAG_FAKE_MODE?.trim();
  return {
    provider: env.STUDENT_RAG_PROVIDER?.trim() || undefined,
    cerebrasApiKey: env.CEREBRAS_API_KEY?.trim() || undefined,
    cerebrasBaseUrl: env.CEREBRAS_BASE_URL?.trim() || undefined,
    cerebrasModel: env.CEREBRAS_MODEL?.trim() || undefined,
    fakeMode: fakeMode && VALID_FAKE_MODES.has(fakeMode) ? fakeMode as StudentRagEnv["fakeMode"] : undefined
  };
}

/**
 * Retriever bound to a single published book. Scope comes exclusively from
 * the server session + route parameter; a missing or mismatched scope fails
 * closed before any content is read.
 */
export class ScopedBookContentRetriever implements Retriever {
  constructor(private readonly dataSource: StudentDataSource) {}

  async retrieve(input: RetrieverInput): Promise<readonly RetrievedChunk[]> {
    if (!input.scope || !input.scope.studentId || !input.scope.bookId) {
      throw new RagApplicationError({ code: "RAG_INVALID_REQUEST", reasonCode: "scope_missing" });
    }
    const contents = await this.dataSource.getContents(input.scope.bookId);
    const tokens = tokenize(input.query);
    const scored = contents
      .map((content) => {
        const text = content.contentText.toLowerCase();
        const score = tokens.reduce((acc, token) => acc + (text.includes(token) ? 1 : 0), 0);
        return { content, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.topK);
    return scored.map(({ content }) => ({
      id: content.id,
      content: content.contentText,
      label: content.chapterId ? `chapter:${content.chapterId}` : "book-content",
      locator: content.pageNumber !== null ? `p.${content.pageNumber}` : undefined
    }));
  }
}

function tokenize(query: string): string[] {
  const ascii = query.toLowerCase().match(/[a-z0-9\u00c0-\u024f]{2,}/g) ?? [];
  // CJK runs are indexed as the full run plus every bigram so natural
  // Chinese questions ("光合作用如何運作") still hit stored content.
  const cjk: string[] = [];
  for (const run of query.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    cjk.push(run);
    for (let index = 0; index + 2 <= run.length; index += 1) {
      cjk.push(run.slice(index, index + 2));
    }
  }
  return [...new Set([...ascii, ...cjk])];
}

/** Deterministic offline provider used by smoke gates; never calls a vendor. */
export function createFakeRagProvider(
  mode: "grounded" | "invalid_citation" | "weak_source" | "partial_unsupported" | "unsupported_number" | "evidence_quote_tamper" = "grounded"
): LlmProvider {
  return new FakeLlmProvider({
    handler: (input: LlmGenerateInput) => {
      if (mode === "invalid_citation") {
        // Fabricate a citation the retriever never supplied: the pipeline
        // must reject it via the citation validator and fail closed.
        return JSON.stringify({
          answer: "This answer cites a chunk that does not exist.",
          citations: [{ chunkId: "chunk-never-retrieved", label: "forged" }],
          claims: [],
          confidence: "high"
        });
      }

      // Parse the first evidence block from the prompt to build grounded output.
      const evidence = parseFirstEvidenceBlock(input.userPrompt);
      if (!evidence) {
        return JSON.stringify({ answer: "No sufficient evidence was found.", citations: [], claims: [], confidence: "low" });
      }

      if (mode === "evidence_quote_tamper") {
        // Quote is NOT a substring of the chunk → integrity hard fail.
        return JSON.stringify({
          answer: "Tampered evidence.",
          citations: [{
            chunkId: evidence.chunkId, label: evidence.label,
            evidenceQuote: "THIS_QUOTE_DOES_NOT_EXIST_IN_CHUNK",
            contentHash: hashEvidenceSpan(evidence.content.slice(0, 10)),
            hashAlgorithm: "sha256"
          }],
          claims: [],
          confidence: "high"
        });
      }

      if (mode === "weak_source") {
        // Cite the chunk but answer with unrelated text → low overlap → unsupported.
        const answer = "量子力學的測不準原理是物理學的重要概念。";
        const claimText = answer;
        return JSON.stringify({
          answer,
          citations: [{ chunkId: evidence.chunkId, label: evidence.label }],
          claims: [{
            claimId: "claim-weak-1",
            text: claimText,
            answerStart: 0,
            answerEnd: claimText.length,
            status: "supported",
            citationChunkIds: [evidence.chunkId],
            evidence: [{ quote: evidence.content.slice(0, 20), chunkId: evidence.chunkId, start: 0, end: Math.min(20, evidence.content.length) }]
          }],
          confidence: "high"
        });
      }

      if (mode === "unsupported_number") {
        // Supported context claim (full content) + unsupported numeric claim.
        const supportedClaim = evidence.content;
        const numericAnswer = `${supportedClaim}光反應的效率為 99.7%。`;
        const supportedEnd = supportedClaim.length;
        const unsupportedText = "光反應的效率為 99.7%。";
        const unsupportedStart = supportedEnd;
        return JSON.stringify({
          answer: numericAnswer,
          citations: [{ chunkId: evidence.chunkId, label: evidence.label }],
          claims: [
            {
              claimId: "claim-num-supported",
              text: supportedClaim,
              answerStart: 0,
              answerEnd: supportedEnd,
              status: "supported",
              citationChunkIds: [evidence.chunkId],
              evidence: [{ quote: supportedClaim, chunkId: evidence.chunkId, start: 0, end: supportedEnd }]
            },
            {
              claimId: "claim-num-unsupported",
              text: unsupportedText,
              answerStart: unsupportedStart,
              answerEnd: unsupportedStart + unsupportedText.length,
              status: "supported",
              riskCategory: "number",
              citationChunkIds: [evidence.chunkId],
              evidence: [{ quote: supportedClaim, chunkId: evidence.chunkId, start: 0, end: supportedEnd }]
            }
          ],
          confidence: "high"
        });
      }

      if (mode === "partial_unsupported") {
        // Supported claim (full content) + one unsupported general claim (low overlap).
        const supportedClaim = evidence.content;
        const unsupportedClaim = "此機制也適用於深海熱泉生態系統。";
        const answer = `${supportedClaim}${unsupportedClaim}`;
        const supEnd = supportedClaim.length;
        return JSON.stringify({
          answer,
          citations: [{ chunkId: evidence.chunkId, label: evidence.label }],
          claims: [
            {
              claimId: "claim-partial-sup",
              text: supportedClaim,
              answerStart: 0,
              answerEnd: supEnd,
              status: "supported",
              citationChunkIds: [evidence.chunkId],
              evidence: [{ quote: supportedClaim, chunkId: evidence.chunkId, start: 0, end: supEnd }]
            },
            {
              claimId: "claim-partial-unsup",
              text: unsupportedClaim,
              answerStart: supEnd,
              answerEnd: supEnd + unsupportedClaim.length,
              status: "supported",
              citationChunkIds: [evidence.chunkId],
              evidence: [{ quote: supportedClaim, chunkId: evidence.chunkId, start: 0, end: supEnd }]
            }
          ],
          confidence: "high"
        });
      }

      // mode === "grounded": fully grounded answer with verbatim claim + evidence.
      // The claim text IS the full evidence content so the rule-based validator
      // sees maximum token overlap (Jaccard/coverage) and marks it supported.
      const claimText = evidence.content;
      const answer = `依據書本內容（${evidence.label || evidence.chunkId}）：${claimText}`;
      const claimStart = answer.indexOf(claimText);
      return JSON.stringify({
        answer,
        citations: [{ chunkId: evidence.chunkId, label: evidence.label || evidence.chunkId }],
        claims: [{
          claimId: "claim-grounded-1",
          text: claimText,
          answerStart: claimStart,
          answerEnd: claimStart + claimText.length,
          status: "supported",
          citationChunkIds: [evidence.chunkId],
          evidence: [{
            quote: claimText,
            chunkId: evidence.chunkId,
            start: 0,
            end: claimText.length
          }]
        }],
        confidence: "high"
      });
    }
  });
}

type ParsedEvidence = { chunkId: string; label: string; content: string };

/** Extract the first evidence block { chunkId, label, content } from the prompt. */
function parseFirstEvidenceBlock(prompt: string): ParsedEvidence | null {
  // The prompt emits each block as a JSON.stringify'd object line. Extract the
  // first such object and parse it robustly (handles all key orderings/escapes).
  const blockMatch = prompt.match(/\{[^{}]*"chunkId"[\s\S]*?\}/);
  if (!blockMatch) return null;
  try {
    const obj = JSON.parse(blockMatch[0]) as { chunkId?: string; label?: string; content?: string };
    if (typeof obj.chunkId !== "string" || typeof obj.label !== "string" || typeof obj.content !== "string") return null;
    return { chunkId: obj.chunkId, label: obj.label, content: obj.content };
  } catch {
    return null;
  }
}

export function createStudentRagProvider(options: StudentRagEnv): LlmProvider {
  const mode = options.provider ?? (options.cerebrasApiKey ? "cerebras" : undefined);
  if (mode === "fake") return createFakeRagProvider(options.fakeMode ?? "grounded");
  if (mode === "cerebras") {
    // Fail closed: without a credential the adapter still constructs, but
    // every generation resolves no credential and maps to AUTH_FAILED.
    return new CerebrasLlmProvider({
      credentialResolver: async () => (options.cerebrasApiKey ? { apiKey: options.cerebrasApiKey } : undefined),
      baseUrl: options.cerebrasBaseUrl,
      model: options.cerebrasModel
    });
  }
  // No provider configured: fail closed with a clear provider error.
  return new FakeLlmProvider({
    handler: () => {
      throw new RagApplicationError({ code: "RAG_PROVIDER_AUTH_FAILED", provider: "cerebras", failureKind: "auth_failed" });
    }
  });
}

export type StudentRagRouterOptions = {
  getDataSource: () => StudentDataSource | null;
  application?: RagApplicationService;
  env?: StudentRagEnv;
};

export function createStudentRagRouter(options: StudentRagRouterOptions): Router {
  const router = Router();
  let application: RagApplicationService | null = options.application ?? null;

  function resolveApplication(): RagApplicationService {
    if (application) return application;
    const dataSource = options.getDataSource();
    if (!dataSource) throw new RagApplicationError({ code: "RAG_PROVIDER_UNAVAILABLE" });
    application = new RagApplicationService({
      retriever: new ScopedBookContentRetriever(dataSource),
      provider: createStudentRagProvider(options.env ?? resolveStudentRagEnv()),
      // Independent rule-based validator; the generator's confidence is never
      // an input and disagreement resolves to the validator's verdict.
      groundingValidator: new RuleBasedGroundingValidator()
    });
    return application;
  }

  router.post("/books/:bookId/rag-ask", async (req: Request, res: Response) => {
    const requestId = randomUUID();
    const auth = req.studentAuth;
    if (!auth) {
      res.status(401).json({ error: "AUTH_REQUIRED" });
      return;
    }
    const bookId = String(req.params.bookId ?? "");
    if (!bookId || bookId.length > 128) {
      res.status(400).json({ contractVersion: 1, requestId, error: { code: "RAG_INVALID_REQUEST", message: "RAG request is invalid.", retryable: false } });
      return;
    }

    // Public wire contract: the browser may only send query/conversationId.
    // Any attempt to supply identity (studentId) or scope is rejected.
    const parsed = studentRagAskRequestV1Schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ contractVersion: 1, requestId, error: { code: "RAG_INVALID_REQUEST", message: "RAG request is invalid.", retryable: false } });
      return;
    }

    const dataSource = options.getDataSource();
    if (!dataSource) {
      res.status(503).json({ error: "student data source unavailable" });
      return;
    }
    try {
      const book = await dataSource.getBook(bookId);
      if (!book) {
        res.status(404).json({ contractVersion: 1, requestId, error: { code: "RAG_INVALID_REQUEST", message: "RAG request is invalid.", retryable: false } });
        return;
      }

      // Scope is derived from the server session and the route parameter.
      const scope: RagScope = { studentId: auth.user.id, bookId };
      const response = await resolveApplication().answer({
        contractVersion: 1,
        requestId,
        query: parsed.data.query,
        topK: 6,
        maxOutputTokens: 1_024,
        scope
      }, req.signal);
      res.setHeader("Cache-Control", "no-store");
      res.json(response);
    } catch (error) {
      const safeError = asRagApplicationError(error);
      res.setHeader("Cache-Control", "no-store");
      res.status(safeError.httpStatus).json(safeError.toResponse(requestId));
    }
  });

  return router;
}
