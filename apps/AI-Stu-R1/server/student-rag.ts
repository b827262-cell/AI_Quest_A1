import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { studentRagAskRequestV1Schema } from "@ai-smartbook/contracts";
import {
  CerebrasLlmProvider,
  FakeLlmProvider,
  RagApplicationError,
  RagApplicationService,
  asRagApplicationError,
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
};

export function resolveStudentRagEnv(env: NodeJS.ProcessEnv = process.env): StudentRagEnv {
  return {
    provider: env.STUDENT_RAG_PROVIDER?.trim() || undefined,
    cerebrasApiKey: env.CEREBRAS_API_KEY?.trim() || undefined,
    cerebrasBaseUrl: env.CEREBRAS_BASE_URL?.trim() || undefined,
    cerebrasModel: env.CEREBRAS_MODEL?.trim() || undefined
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
  const cjk = query.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...new Set([...ascii, ...cjk])];
}

/** Deterministic offline provider used by smoke gates; never calls a vendor. */
export function createFakeRagProvider(): LlmProvider {
  return new FakeLlmProvider({
    handler: (input: LlmGenerateInput) => {
      // Deterministic grounded answer: quote the first evidence block the
      // retriever supplied and cite exactly that chunk.
      const marker = input.userPrompt.match(/\{"chunkId":"([^"]+)"[^}]*"label":"([^"]*)"/);
      if (!marker) {
        return JSON.stringify({ answer: "No sufficient evidence was found.", citations: [], confidence: "low" });
      }
      const [, chunkId, label] = marker;
      return JSON.stringify({
        answer: `依據書本內容（${label || chunkId}）：已根據檢索到的證據區塊回答。`,
        citations: [{ chunkId, label: label || chunkId }],
        confidence: "high"
      });
    }
  });
}

export function createStudentRagProvider(options: StudentRagEnv): LlmProvider {
  const mode = options.provider ?? (options.cerebrasApiKey ? "cerebras" : undefined);
  if (mode === "fake") return createFakeRagProvider();
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
      provider: createStudentRagProvider(options.env ?? resolveStudentRagEnv())
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
