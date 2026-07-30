import { describe, expect, it } from "vitest";
import {
  errorCategoryFromFailureKind,
  toSafeAiDiagnostics
} from "../src/gateway/diagnostics-allowlist";

describe("toSafeAiDiagnostics allowlist", () => {
  it("keeps whitelisted primitive fields", () => {
    const out = toSafeAiDiagnostics({
      provider: "openai",
      model: "gpt-test",
      finishReason: "length",
      promptTokens: 10,
      completionTokens: 5,
      configuredMaxOutputTokens: 4096,
      durationMs: 123,
      providerTimeout: false,
      gatewayTimeout: false,
      clientAborted: false,
      streamStarted: true,
      streamCompleted: true,
      fallbackUsed: false,
      continuationAttempted: true,
      continuationCompleted: true,
      answerComplete: true,
      errorCategory: "token_limit",
      httpStatusClass: "4xx"
    });
    expect(out).toEqual({
      provider: "openai",
      model: "gpt-test",
      finishReason: "length",
      promptTokens: 10,
      completionTokens: 5,
      configuredMaxOutputTokens: 4096,
      durationMs: 123,
      providerTimeout: false,
      gatewayTimeout: false,
      clientAborted: false,
      streamStarted: true,
      streamCompleted: true,
      fallbackUsed: false,
      continuationAttempted: true,
      continuationCompleted: true,
      answerComplete: true,
      errorCategory: "token_limit",
      httpStatusClass: "4xx"
    });
  });

  it("drops unknown keys (no spread)", () => {
    const out = toSafeAiDiagnostics({
      provider: "openai",
      futureUnknownField: "leak",
      anotherNew: { nested: "leak" }
    });
    expect(out).toEqual({ provider: "openai" });
    expect(out).not.toHaveProperty("futureUnknownField");
    expect(out).not.toHaveProperty("anotherNew");
  });

  it("drops nested objects/arrays even on allowlisted keys", () => {
    const out = toSafeAiDiagnostics({
      provider: "openai",
      // A stray object on an allowlisted key must be dropped, not stringified.
      model: { leak: "secret" },
      finishReason: ["a", "b"]
    });
    expect(out).toEqual({ provider: "openai" });
    expect(out).not.toHaveProperty("model");
    expect(out).not.toHaveProperty("finishReason");
  });

  const SENSITIVE_PAYLOAD = {
    provider: "openai",
    authorization: "Bearer sk-leak-1234567890",
    apiKey: "sk-leak-1234567890",
    prompt: "請詳述四種排序演算法的運作原理",
    answer: "泡沫排序是...完整答案全文",
    rawBody: '{"choices":[{"message":{"content":"完整答案"}}]}',
    headers: { authorization: "Bearer sk-leak", cookie: "session=abc" },
    credential: { ciphertext: "encrypted-key", fingerprint: "fp123" },
    recoveryToken: "abcdef0123456789".repeat(4),
    ip: "203.0.113.42",
    stack: "Error: at /secret/path/server.ts:42",
    cookie: "session=secret",
    "set-cookie": "session=secret",
    userAgent: "Mozilla/5.0 (full ua string with fingerprints)"
  };

  const SENSITIVE_KEYS = [
    "authorization",
    "apiKey",
    "prompt",
    "answer",
    "rawBody",
    "headers",
    "credential",
    "recoveryToken",
    "ip",
    "stack",
    "cookie",
    "set-cookie",
    "userAgent"
  ];

  const SENSITIVE_VALUES = [
    SENSITIVE_PAYLOAD.authorization,
    SENSITIVE_PAYLOAD.apiKey,
    SENSITIVE_PAYLOAD.prompt,
    SENSITIVE_PAYLOAD.answer,
    SENSITIVE_PAYLOAD.rawBody,
    "ciphertext",
    "fingerprint",
    SENSITIVE_PAYLOAD.recoveryToken,
    "203.0.113.42",
    "/secret/path",
    "session=secret",
    SENSITIVE_PAYLOAD.userAgent
  ];

  it("strips all sensitive keys from the output", () => {
    const out = toSafeAiDiagnostics(SENSITIVE_PAYLOAD);
    const serialized = JSON.stringify(out);
    for (const key of SENSITIVE_KEYS) {
      expect(out).not.toHaveProperty(key);
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it("strips all sensitive values from the output", () => {
    const out = toSafeAiDiagnostics(SENSITIVE_PAYLOAD);
    const serialized = JSON.stringify(out);
    for (const value of SENSITIVE_VALUES) {
      expect(serialized).not.toContain(value);
    }
  });

  it("only retains the allowlisted provider field from a sensitive payload", () => {
    const out = toSafeAiDiagnostics(SENSITIVE_PAYLOAD);
    expect(out).toEqual({ provider: "openai" });
  });

  it("handles non-object input safely", () => {
    expect(toSafeAiDiagnostics(null)).toEqual({});
    expect(toSafeAiDiagnostics(undefined)).toEqual({});
    expect(toSafeAiDiagnostics("string")).toEqual({});
    expect(toSafeAiDiagnostics(42)).toEqual({});
  });

  it("does NOT include lastChunk (may contain answer text)", () => {
    const out = toSafeAiDiagnostics({
      provider: "openai",
      lastChunk: "partial answer text"
    });
    expect(out).not.toHaveProperty("lastChunk");
    expect(JSON.stringify(out)).not.toContain("partial answer text");
  });
});

describe("errorCategoryFromFailureKind", () => {
  it.each([
    ["provider_timeout", "provider_timeout"],
    ["gateway_timeout", "gateway_timeout"],
    ["client_abort", "client_abort"],
    ["provider_rate_limit", "rate_limited"],
    ["provider_server_error", "provider_5xx"],
    ["stream_format", "invalid_response"],
    ["token_length", "token_limit"],
    ["answer_save", "persistence_failure"]
  ] as const)("maps %s -> %s", (kind, expected) => {
    expect(errorCategoryFromFailureKind(kind)).toBe(expected);
  });

  it("returns undefined for unknown kinds", () => {
    expect(errorCategoryFromFailureKind("something_new")).toBeUndefined();
    expect(errorCategoryFromFailureKind(undefined)).toBeUndefined();
  });
});
