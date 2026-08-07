import { describe, expect, it } from "vitest";
import {
  FakeLlmProvider,
  FakeRetriever,
  RagApplicationService,
  type RagScope,
  type Retriever,
  type RetrieverInput,
  type RetrievedChunk
} from "../../src/rag/server";

const SCOPE_A: RagScope = { studentId: "student-a", bookId: "book-a" };
const SCOPE_B: RagScope = { studentId: "student-b", bookId: "book-b" };

const CHUNK_A: RetrievedChunk = { id: "chunk-a", label: "Book A ch1", content: "Fact from book A." };
const CHUNK_B: RetrievedChunk = { id: "chunk-b", label: "Book B ch1", content: "Fact from book B." };

function groundedProvider(chunk: RetrievedChunk): FakeLlmProvider {
  return new FakeLlmProvider({ response: {
    answer: chunk.content,
    citations: [{ chunkId: chunk.id, label: chunk.label }],
    confidence: "high"
  } });
}

describe("retriever scope isolation", () => {
  it("passes the server-derived scope to the retriever untouched", async () => {
    const retriever = new FakeRetriever([CHUNK_A], { requiredScope: SCOPE_A });
    const application = new RagApplicationService({ retriever, provider: groundedProvider(CHUNK_A) });
    await application.answer({ contractVersion: 1, requestId: "scope-passthrough", query: "question", topK: 3, maxOutputTokens: 64, scope: SCOPE_A });
    expect(retriever.calls[0].scope).toEqual(SCOPE_A);
  });

  it("prevents a book A student session from retrieving book B chunks", async () => {
    const retriever = new FakeRetriever([CHUNK_B], { requiredScope: SCOPE_B });
    const application = new RagApplicationService({ retriever, provider: groundedProvider(CHUNK_B) });
    await expect(application.answer({
      contractVersion: 1, requestId: "scope-cross-book", query: "question", topK: 3, maxOutputTokens: 64, scope: SCOPE_A
    })).rejects.toMatchObject({ code: "RAG_INVALID_REQUEST", reasonCode: "scope_mismatch" });
  });

  it("prevents student A from overwriting student B's scope at the retriever boundary", async () => {
    const retriever = new FakeRetriever([CHUNK_B], { requiredScope: SCOPE_B });
    await expect(retriever.retrieve({ requestId: "spoof", query: "q", topK: 3, scope: { ...SCOPE_B, studentId: "student-a" } }))
      .rejects.toMatchObject({ code: "RAG_INVALID_REQUEST", reasonCode: "scope_mismatch" });
  });

  it("refuses to retrieve when no scope is present", async () => {
    const retriever = new FakeRetriever([CHUNK_A]);
    await expect(retriever.retrieve({ requestId: "no-scope", query: "q", topK: 3, scope: undefined as unknown as RagScope }))
      .rejects.toMatchObject({ code: "RAG_INVALID_REQUEST", reasonCode: "scope_missing" });
  });

  it("never lets a citation reference a chunk outside the scoped retrieval set", async () => {
    // Retriever scoped to book A only returns chunk-a; the provider tries to
    // cite chunk-b (out of scope) and the citation validator fails closed.
    const retriever = new FakeRetriever([CHUNK_A], { requiredScope: SCOPE_A });
    const application = new RagApplicationService({ retriever, provider: groundedProvider(CHUNK_B) });
    await expect(application.answer({
      contractVersion: 1, requestId: "scope-citation", query: "question", topK: 3, maxOutputTokens: 64, scope: SCOPE_A
    })).rejects.toMatchObject({ code: "RAG_CITATION_INVALID" });
  });

  it("rejects contract requests with missing or spoofed scope fields", async () => {
    const neverCalled: Retriever = { retrieve: async (_input: RetrieverInput) => { throw new Error("must not retrieve"); } };
    const application = new RagApplicationService({ retriever: neverCalled, provider: new FakeLlmProvider() });
    await expect(application.answer({ contractVersion: 1, requestId: "missing-scope", query: "q", topK: 3, maxOutputTokens: 64 }))
      .rejects.toMatchObject({ code: "RAG_INVALID_REQUEST" });
    await expect(application.answer({ contractVersion: 1, requestId: "empty-scope", query: "q", topK: 3, maxOutputTokens: 64, scope: { studentId: "", bookId: "" } }))
      .rejects.toMatchObject({ code: "RAG_INVALID_REQUEST" });
  });
});
