import { describe, expect, it } from "vitest";
import {
  createRagHttpHandler,
  FakeLlmProvider,
  FakeRetriever,
  RagApplicationError,
  RagApplicationService
} from "../../src/rag/server";

const chunk = { id: "chunk-1", label: "Chapter 1", content: "A grounded fact." };

describe("RAG HTTP route adapter", () => {
  it("maps a POST request to the application service and returns the contract response", async () => {
    const application = new RagApplicationService({
      retriever: new FakeRetriever([chunk]),
      provider: new FakeLlmProvider({ response: {
        answer: "A grounded fact.",
        citations: [{ chunkId: "chunk-1", label: "Chapter 1" }],
        confidence: "high"
      } })
    });
    const handle = createRagHttpHandler(application);
    const result = await handle({ method: "POST", body: { requestId: "http-1", query: "question", scope: { studentId: "student-1", bookId: "book-1" } } });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ contractVersion: 1, requestId: "http-1", grounding: "verified" });
  });

  it("does not leak provider error details through the route", async () => {
    const application = {
      answer: async () => {
        throw new RagApplicationError({ code: "RAG_PROVIDER_TIMEOUT", provider: "cerebras", retryable: true, failureKind: "timeout" });
      }
    };
    const handle = createRagHttpHandler(application);
    const result = await handle({ method: "POST", body: { requestId: "http-timeout", query: "question", scope: { studentId: "student-1", bookId: "book-1" } } });
    expect(result).toEqual({
      status: 504,
      body: {
        contractVersion: 1,
        requestId: "http-timeout",
        error: { code: "RAG_PROVIDER_TIMEOUT", message: "The AI provider timed out. Please try again.", retryable: true }
      }
    });
  });

  it("rejects requests without a server-injected scope fail-closed", async () => {
    const application = new RagApplicationService({
      retriever: new FakeRetriever([chunk]),
      provider: new FakeLlmProvider({ response: { answer: "never", citations: [], confidence: "low" } })
    });
    const handle = createRagHttpHandler(application);
    const result = await handle({ method: "POST", body: { requestId: "http-no-scope", query: "question" } });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "RAG_INVALID_REQUEST" } });
  });

  it("rejects unsupported methods and malformed request bodies safely", async () => {
    const handle = createRagHttpHandler({ answer: async () => {
      throw new Error("should not be called");
    } });
    const method = await handle({ method: "GET", body: {} });
    expect(method.status).toBe(400);
    expect(method.body).toMatchObject({ error: { code: "RAG_INVALID_REQUEST" } });
    const malformed = await handle({ method: "POST", body: null });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: "RAG_INVALID_REQUEST" } });
  });
});
