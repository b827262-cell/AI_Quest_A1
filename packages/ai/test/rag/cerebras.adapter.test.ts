import { afterEach, describe, expect, it, vi } from "vitest";
import { CerebrasLlmProvider } from "../../src/rag/server";

afterEach(() => vi.restoreAllMocks());

function provider(fetchImpl: typeof fetch = fetch): CerebrasLlmProvider {
  return new CerebrasLlmProvider({
    credentialResolver: async () => ({ apiKey: "cerebras-test-key-not-for-output" }),
    model: "gpt-oss-test",
    baseUrl: "https://cerebras.test/v1",
    fetchImpl
  });
}

describe("Cerebras RAG adapter", () => {
  it("maps the OpenAI-compatible success response to the neutral LLM port", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://cerebras.test/v1/chat/completions");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer cerebras-test-key-not-for-output");
      const body = JSON.parse(String(init?.body)) as { model: string; messages: unknown[]; stream: boolean };
      expect(body).toMatchObject({ model: "gpt-oss-test", stream: false });
      expect(body.messages).toHaveLength(2);
      return new Response(JSON.stringify({
        model: "gpt-oss-test",
        choices: [{ message: { content: "{\"answer\":\"ok\",\"citations\":[],\"confidence\":\"low\"}" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      }), { status: 200 });
    });

    const result = await provider(fetchMock).generate({
      requestId: "rag-success",
      systemPrompt: "system",
      userPrompt: "user",
      maxOutputTokens: 100
    });
    expect(result).toMatchObject({ text: "{\"answer\":\"ok\",\"citations\":[],\"confidence\":\"low\"}", model: "gpt-oss-test" });
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  });

  it("maps rate limits without exposing the upstream body or key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "cerebras-test-key-not-for-output" }), { status: 429 }));
    await expect(provider(fetchMock).generate({
      requestId: "rag-rate-limit", systemPrompt: "", userPrompt: "", maxOutputTokens: 10
    })).rejects.toMatchObject({ code: "RAG_PROVIDER_RATE_LIMITED", retryable: true });
    try {
      await provider(fetchMock).generate({ requestId: "rag-rate-limit-2", systemPrompt: "", userPrompt: "", maxOutputTokens: 10 });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("cerebras-test-key");
    }
  });

  it("maps an invalid JSON/content response fail-closed", async () => {
    const invalidJson = vi.fn(async () => new Response("<html>not json</html>", { status: 200 }));
    await expect(provider(invalidJson).generate({
      requestId: "rag-invalid-json", systemPrompt: "", userPrompt: "", maxOutputTokens: 10
    })).rejects.toMatchObject({ code: "RAG_PROVIDER_INVALID_RESPONSE", retryable: false });

    const invalidShape = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }));
    await expect(provider(invalidShape).generate({
      requestId: "rag-invalid-shape", systemPrompt: "", userPrompt: "", maxOutputTokens: 10
    })).rejects.toMatchObject({ code: "RAG_PROVIDER_INVALID_RESPONSE" });
  });

  it("maps timeout and upstream failure to safe stable codes", async () => {
    const timeoutFetch = vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("transport timeout")), { once: true });
    }));
    const timeoutProvider = new CerebrasLlmProvider({
      credentialResolver: async () => ({ apiKey: "timeout-test-key" }),
      timeoutMs: 100,
      fetchImpl: timeoutFetch
    });
    await expect(timeoutProvider.generate({ requestId: "rag-timeout", systemPrompt: "", userPrompt: "", maxOutputTokens: 10 }))
      .rejects.toMatchObject({ code: "RAG_PROVIDER_TIMEOUT", failureKind: "timeout" });

    const serverError = vi.fn(async () => new Response("upstream private error", { status: 503 }));
    await expect(provider(serverError).generate({ requestId: "rag-503", systemPrompt: "", userPrompt: "", maxOutputTokens: 10 }))
      .rejects.toMatchObject({ code: "RAG_PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("requires a server credential resolver", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const unavailable = new CerebrasLlmProvider({ credentialResolver: async () => undefined, fetchImpl: fetchMock });
    await expect(unavailable.generate({ requestId: "rag-no-key", systemPrompt: "", userPrompt: "", maxOutputTokens: 10 }))
      .rejects.toMatchObject({ code: "RAG_PROVIDER_AUTH_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
