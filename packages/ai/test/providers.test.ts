import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiGateway,
  GeminiGatewayProvider,
  KimiGatewayProvider,
  OpenAiGatewayProvider,
  QwenGatewayProvider,
  ZaiGatewayProvider,
  normalizeZaiBaseUrl,
  AiGatewayError,
  MockGatewayProvider
} from "../src";

afterEach(() => vi.unstubAllGlobals());

describe("real providers without API key", () => {
  it("all report unavailable when key unset", async () => {
    const providers = [
      new GeminiGatewayProvider({ apiKey: undefined }),
      new OpenAiGatewayProvider({ apiKey: undefined }),
      new KimiGatewayProvider({ apiKey: undefined }),
      new QwenGatewayProvider({ apiKey: undefined }),
      new ZaiGatewayProvider({ apiKey: undefined })
    ];
    for (const p of providers) {
      expect(await p.isAvailable()).toBe(false);
    }
  });

  it("throw AI_PROVIDER_UNAVAILABLE on generate() without key", async () => {
    const p = new OpenAiGatewayProvider({ apiKey: undefined });
    await expect(
      p.generate({ requestId: "r", prompt: "hi" })
    ).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", failedProvider: "openai" });
  });

  it("use default model names that are configurable (not hardcoded in router)", () => {
    const g = new GeminiGatewayProvider({ apiKey: undefined, model: "custom-gemini" });
    expect(g.defaultModel).toBe("custom-gemini");
    const k = new KimiGatewayProvider({ apiKey: undefined, baseUrl: "https://example.com/v1" });
    expect(k.defaultModel).toBe("moonshot-v1-8k");
  });

  it("errors never leak the API key text", async () => {
    const p = new OpenAiGatewayProvider({ apiKey: "sk-secret-test-key-1234567890" });
    // Force a failure by pointing at an invalid host.
    (p as unknown as { baseUrl: string }).baseUrl = "http://127.0.0.1:1/v1";
    let thrown: unknown;
    try {
      await p.generate({ requestId: "r", prompt: "hi" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AiGatewayError);
    const msg = JSON.stringify(thrown);
    expect(msg).not.toContain("sk-secret-test-key");
  });

  it("maps a normal OpenAI-compatible response and sends the auth contract", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      const body = JSON.parse(String(init?.body)) as { model: string; messages: unknown[] };
      expect(body.model).toBe("gpt-test");
      expect(body.messages).toHaveLength(1);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "答案" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiGatewayProvider({ apiKey: "test-key", baseUrl: "https://provider.test/v1", model: "gpt-test" });
    const result = await provider.generate({ requestId: "r", prompt: "hi" });
    expect(result).toMatchObject({ provider: "openai", answer: "答案", inputTokens: 4, outputTokens: 6 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the Z.AI base URL exactly once and sends the Bearer contract", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer zai-test-key");
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "glm-test" });
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await new ZaiGatewayProvider({
      apiKey: "zai-test-key",
      baseUrl: "https://api.z.ai/api/paas/v4/v4/",
      model: "glm-test"
    }).generate({ requestId: "zai-url", prompt: "hello" });
    expect(normalizeZaiBaseUrl("https://api.z.ai/api/paas")).toBe("https://api.z.ai/api/paas/v4");
    expect(normalizeZaiBaseUrl("https://api.z.ai/api/coding/paas/v4/")).toBe("https://api.z.ai/api/coding/paas/v4");
  });

  it("preserves missing usage and exposes an empty answer for gateway validation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }
    )));
    const result = await new OpenAiGatewayProvider({ apiKey: "k", baseUrl: "https://x.test" })
      .generate({ requestId: "r", prompt: "hi" });
    expect(result.answer).toBe("");
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  it.each([401, 403, 429, 500])("classifies upstream HTTP %s without leaking the body", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "sk-upstream-secret-123456789" }), { status }
    )));
    const provider = new OpenAiGatewayProvider({ apiKey: "sk-client-secret-123456789" });
    try {
      await provider.generate({ requestId: "r", prompt: "hi" });
    } catch (error) {
      expect(error).toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", failedProvider: "openai" });
      expect(JSON.stringify(error)).not.toContain("secret");
      expect((error as { retryable: boolean }).retryable).toBe(status >= 500 || status === 429);
    }
  });

  it("maps invalid JSON to a safe provider error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>500</html>", { status: 200 })));
    await expect(new OpenAiGatewayProvider({ apiKey: "k" }).generate({ requestId: "r", prompt: "hi" }))
      .rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", retryable: false });
  });

  it("uses the Gemini header contract and preserves each compatible provider id", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("gemini")) {
        expect(url).not.toContain("AIza");
        expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-test-key");
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "gemini answer" }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 }
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const gemini = await new GeminiGatewayProvider({
      apiKey: "AIza-test-key", baseUrl: "https://gemini.test/v1beta", model: "gemini-test"
    }).generate({ requestId: "r", prompt: "hi" });
    const kimi = await new KimiGatewayProvider({ apiKey: "k", baseUrl: "https://kimi.test/v1" })
      .generate({ requestId: "r", prompt: "hi" });
    const qwen = await new QwenGatewayProvider({ apiKey: "k", baseUrl: "https://qwen.test/v1" })
      .generate({ requestId: "r", prompt: "hi" });
    expect(gemini.provider).toBe("gemini");
    expect(kimi.provider).toBe("kimi");
    expect(qwen.provider).toBe("qwen");
  });

  it("uses the official Gemini API base URL by default", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\//);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await new GeminiGatewayProvider({ apiKey: "test-key", model: "configured-model" })
      .generate({ requestId: "gemini-default-url", prompt: "hello" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses Gemini Native profile with only x-goog-api-key", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
      expect(headers["x-goog-api-key"]).toBe("opaque-test-key");
      expect(headers.Authorization).toBeUndefined();
      expect(url).not.toContain("?key=");
      const body = JSON.parse(String(init?.body)) as { contents: unknown[] };
      expect(body.contents).toHaveLength(1);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "native" }] } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new GeminiGatewayProvider({
      apiKey: "opaque-test-key",
      model: "gemini-test",
      endpointProfile: "gemini_native"
    }).generate({ requestId: "gemini-native-profile", prompt: "hello" });
    expect(result.answer).toBe("native");
  });

  it("uses Gemini OpenAI-compatible profile with only Authorization", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
      expect(headers.Authorization).toBe("Bearer opaque-test-key");
      expect(headers["x-goog-api-key"]).toBeUndefined();
      expect(url).not.toContain("?key=");
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string }> };
      expect(body.model).toBe("gemini-test");
      expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "compatible" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new GeminiGatewayProvider({
      apiKey: "opaque-test-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-test",
      endpointProfile: "gemini_openai_compatible"
    }).generate({ requestId: "gemini-compatible-profile", systemPrompt: "be concise", prompt: "hello" });
    expect(result.answer).toBe("compatible");
    expect(result.totalTokens).toBe(5);
  });

  it("falls back after auth failure without retrying the same provider", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new AiGateway({
      providers: new Map([
        ["openai", new OpenAiGatewayProvider({ apiKey: "k", baseUrl: "https://x.test" })],
        ["mock", new MockGatewayProvider()]
      ]),
      requestTimeoutMs: 100,
      maxRetries: 2,
      maxOutputTokens: 20,
      maxInputChars: 100
    });
    const output = await gateway.run({ requestId: "r", prompt: "hi", preferredProvider: "openai" });
    expect(output.result.provider).toBe("mock");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Gemini token breakdown mapping (spec §6.1, §6.3)", () => {
  it("reads cachedContentTokenCount and thoughtsTokenCount", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "answer" }] } }],
          usageMetadata: {
            promptTokenCount: 1100,
            candidatesTokenCount: 500,
            totalTokenCount: 1800,
            cachedContentTokenCount: 100,
            thoughtsTokenCount: 200
          }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await new GeminiGatewayProvider({ apiKey: "AIza-test", model: "gemini-3.6-flash" }).generate({
      requestId: "r",
      prompt: "hi"
    });
    expect(result.inputTokens).toBe(1100);
    expect(result.outputTokens).toBe(500);
    expect(result.totalTokens).toBe(1800);
    // cached/thinking are surfaced as subsets.
    expect(result.cachedInputTokens).toBe(100);
    expect(result.thinkingTokens).toBe(200);
    expect(result.usageSource).toBe("provider_response");
  });

  it("marks usage as system_estimated when the provider omits usage", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "answer" }] } }] }), {
        status: 200
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await new GeminiGatewayProvider({ apiKey: "AIza-test", model: "gemini-3.6-flash" }).generate({
      requestId: "r",
      prompt: "hi"
    });
    expect(result.totalTokens).toBeUndefined();
    expect(result.usageSource).toBe("system_estimated");
  });
});

describe("OpenAI cached/reasoning token mapping", () => {
  it("reads prompt_tokens_details.cached_tokens and completion_tokens_details.reasoning_tokens", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 400,
            total_tokens: 1400,
            prompt_tokens_details: { cached_tokens: 250 },
            completion_tokens_details: { reasoning_tokens: 150 }
          }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await new OpenAiGatewayProvider({ apiKey: "k", model: "gpt-4o" }).generate({
      requestId: "r",
      prompt: "hi"
    });
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(400);
    expect(result.cachedInputTokens).toBe(250);
    expect(result.thinkingTokens).toBe(150);
  });
});
