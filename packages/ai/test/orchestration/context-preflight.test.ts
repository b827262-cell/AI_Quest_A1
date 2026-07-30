import { describe, expect, it } from "vitest";
import {
  checkContextWindow,
  estimateTokenCount,
  reducedOutputBudget
} from "../../src/orchestration/context-preflight";

describe("estimateTokenCount", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("estimates ~chars/3 for mixed CJK + latin", () => {
    // 6 chars → ceil(6/3) = 2 tokens
    expect(estimateTokenCount("abcdef")).toBe(2);
    // 7 chars → ceil(7/3) = 3 tokens
    expect(estimateTokenCount("abcdefg")).toBe(3);
  });

  it("returns at least 1 for any non-empty text", () => {
    expect(estimateTokenCount("a")).toBe(1);
  });
});

describe("checkContextWindow", () => {
  it("passes when input + output + thinking fit within the window", () => {
    const result = checkContextWindow({
      estimatedInputTokens: 1000,
      reservedOutputTokens: 500,
      reservedThinkingTokens: 0,
      contextWindowTokens: 2000
    });
    expect(result.ok).toBe(true);
    expect(result.totalRequired).toBe(1500);
    expect(result.headroom).toBe(500);
    expect(result.reason).toBeUndefined();
  });

  it("passes when total exactly equals the window boundary", () => {
    const result = checkContextWindow({
      estimatedInputTokens: 1000,
      reservedOutputTokens: 500,
      reservedThinkingTokens: 500,
      contextWindowTokens: 2000
    });
    expect(result.ok).toBe(true);
    expect(result.totalRequired).toBe(2000);
    expect(result.headroom).toBe(0);
  });

  it("fails with context_window_exceeded when total exceeds the window", () => {
    const result = checkContextWindow({
      estimatedInputTokens: 1500,
      reservedOutputTokens: 1000,
      reservedThinkingTokens: 0,
      contextWindowTokens: 2000
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("context_window_exceeded");
    expect(result.totalRequired).toBe(2500);
    expect(result.headroom).toBe(-500);
  });

  it("fails with max_input_exceeded when input alone exceeds the stricter cap", () => {
    const result = checkContextWindow({
      estimatedInputTokens: 5000,
      reservedOutputTokens: 100,
      reservedThinkingTokens: 0,
      contextWindowTokens: 128_000,
      maxInputTokens: 4096
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("max_input_exceeded");
  });

  it("includes thinking tokens in the total", () => {
    const result = checkContextWindow({
      estimatedInputTokens: 1000,
      reservedOutputTokens: 500,
      reservedThinkingTokens: 600,
      contextWindowTokens: 2000
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("context_window_exceeded");
    expect(result.totalRequired).toBe(2100);
  });

  it("reports correct headroom (window - totalRequired, can be negative)", () => {
    const ok = checkContextWindow({
      estimatedInputTokens: 100,
      reservedOutputTokens: 100,
      reservedThinkingTokens: 0,
      contextWindowTokens: 1000
    });
    expect(ok.headroom).toBe(800);

    const over = checkContextWindow({
      estimatedInputTokens: 600,
      reservedOutputTokens: 600,
      reservedThinkingTokens: 0,
      contextWindowTokens: 1000
    });
    expect(over.headroom).toBe(-200);
  });
});

describe("reducedOutputBudget", () => {
  it("returns remaining window after input + thinking", () => {
    const budget = reducedOutputBudget({
      estimatedInputTokens: 1000,
      reservedOutputTokens: 4000,
      reservedThinkingTokens: 500,
      contextWindowTokens: 4096
    });
    // 4096 - 1000 - 500 = 2596
    expect(budget).toBe(2596);
  });

  it("returns 0 when input + thinking already fill the window", () => {
    const budget = reducedOutputBudget({
      estimatedInputTokens: 3500,
      reservedOutputTokens: 4000,
      reservedThinkingTokens: 1000,
      contextWindowTokens: 4096
    });
    expect(budget).toBe(0);
  });
});
