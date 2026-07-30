import { describe, expect, it } from "vitest";
import {
  validateAnswer,
  validateResult,
  AiGatewayError,
  DEFAULT_MAX_ANSWER_CHARS
} from "../src";

describe("answer validator", () => {
  it("accepts a normal answer", () => {
    const { answer, truncated } = validateAnswer("這是一個正常的回答。");
    expect(answer).toBe("這是一個正常的回答。");
    expect(truncated).toBe(false);
  });

  it("rejects empty answers", () => {
    expect(() => validateAnswer("   ")).toThrow(AiGatewayError);
    expect(() => validateAnswer("")).toThrow(AiGatewayError);
    expect(() => validateAnswer("\x00\x07\x1f")).toThrow(AiGatewayError);
  });

  it("strips control characters but keeps newlines", () => {
    const { answer } = validateAnswer("line1\n\x00\x07line2\tend");
    expect(answer).toBe("line1\nline2\tend");
  });

  it("truncates answers exceeding max length", () => {
    const long = "x".repeat(DEFAULT_MAX_ANSWER_CHARS + 100);
    const { answer, truncated } = validateAnswer(long);
    expect(truncated).toBe(true);
    expect(answer.length).toBe(DEFAULT_MAX_ANSWER_CHARS);
  });

  it("rejects raw provider JSON envelopes", () => {
    expect(() =>
      validateAnswer('{"choices":[{"message":{"content":"hi"}}]}')
    ).toThrow(AiGatewayError);
  });

  it("rejects answers containing secrets", () => {
    expect(() => validateAnswer("the key is sk-abcdef0123456789abcdef0123456789")).toThrow(
      AiGatewayError
    );
    expect(() => validateAnswer("Authorization: Bearer eyJhbGciOiJIUzI1")).toThrow(AiGatewayError);
    expect(() => validateAnswer("the opaque key is AQ.abcdefghijklmnopqrstuvwxyz123456")).toThrow(AiGatewayError);
    expect(() => validateAnswer("AQ.short")).not.toThrow();
  });

  it("rejects answers containing internal error markers", () => {
    expect(() => validateAnswer("Error: Unauthorized — invalid api key")).toThrow(AiGatewayError);
    expect(() => validateAnswer("Traceback (most recent call last):")).toThrow(AiGatewayError);
    expect(() => validateAnswer("<html><body>500 Internal Server Error</body></html>")).toThrow(AiGatewayError);
    expect(() => validateAnswer('{"error":{"message":"bad"}}')).toThrow(AiGatewayError);
  });

  it("validateResult preserves non-answer fields", () => {
    const out = validateResult({
      provider: "mock",
      model: "mock-v1",
      answer: "  ok  ",
      latencyMs: 5
    });
    expect(out.answer).toBe("  ok  ");
    expect(out.provider).toBe("mock");
    expect(out.latencyMs).toBe(5);
  });
});
