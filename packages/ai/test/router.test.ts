import { describe, expect, it } from "vitest";
import {
  classify,
  classifySubject,
  classifyTask,
  classifyComplexity,
  routePrompt,
  DEFAULT_ROUTER_CONFIG
} from "../src/gateway/ai-router";
import type { AiProviderId } from "../src/gateway/ai-types";

describe("router classifier", () => {
  it("detects math subject + calculation task", () => {
    expect(classifySubject("請幫我解這題方程式 x^2 + 1 = 0")).toBe("math");
    expect(classifyTask("請計算 123 + 456")).toBe("calculation");
  });

  it("detects programming subject", () => {
    expect(classifySubject("How do I write a python script?")).toBe("programming");
  });

  it("falls back to general subject + question_answering task", () => {
    expect(classifySubject("今天天氣如何")).toBe("general");
    expect(classifyTask("請問一下這個觀念")).toBe("question_answering");
  });

  it("classifies complexity by length", () => {
    expect(classifyComplexity("hi", "question_answering")).toBe("low");
    // A long, multi-step explanation prompt should be high complexity.
    const long = "請說明這個概念的原理、推導過程與應用範例，".repeat(20);
    expect(classifyComplexity(long, "explanation")).toBe("high");
  });
});

describe("routePrompt", () => {
  // A fully-keyed deployment: every provider is available, so routing picks the
  // strategy-preferred provider rather than collapsing to the mock backstop.
  const allAvailable: AiProviderId[] = ["mock", "gemini", "openai", "kimi", "qwen"];

  it("routes math/high complexity to openai per default rules", () => {
    const longMath = "請證明並推導 ".repeat(40) + "這個積分方程式的解法，包含每一步的微分與代數運算";
    const decision = routePrompt(longMath, { availableProviderIds: allAvailable });
    expect(decision.preferredProvider).toBe("openai");
    expect(decision.fallbackProviders).toContain("mock");
    expect(decision.subject).toBe("math");
    expect(decision.reason).toContain("OpenAI");
  });

  it("routes programming to openai", () => {
    const decision = routePrompt("幫我寫一段 javascript 的 debounce 函式", {
      availableProviderIds: allAvailable
    });
    expect(decision.preferredProvider).toBe("openai");
  });

  it("routes long-form humanities to kimi", () => {
    const decision = routePrompt("請幫我整理這段歷史的重點摘要", {
      availableProviderIds: allAvailable
    });
    expect(decision.preferredProvider).toBe("kimi");
  });

  it("routes general zh education to qwen", () => {
    const decision = routePrompt("請解釋這個概念是什麼意思", {
      availableProviderIds: allAvailable
    });
    expect(decision.preferredProvider).toBe("qwen");
  });

  it("filters unavailable providers out of the chain but keeps mock backstop", () => {
    const decision = routePrompt("幫我寫程式", {
      availableProviderIds: ["mock"] // only mock available (no API keys set)
    });
    expect(decision.preferredProvider).toBe("mock");
    expect(decision.fallbackProviders).toEqual([]);
  });

  it("respects an explicit preferredProvider override", () => {
    const decision = routePrompt("幫我寫程式", {
      preferredProvider: "qwen",
      availableProviderIds: ["qwen", "mock"]
    });
    expect(decision.preferredProvider).toBe("qwen");
  });

  it("default config exposes a mock backstop", () => {
    expect(DEFAULT_ROUTER_CONFIG.backstopProvider).toBe("mock");
  });
});
