import { afterEach, describe, expect, it } from "vitest";
import { createAiProvider } from "../src";

const originalNodeEnv = process.env.NODE_ENV;
const originalMockFlag = process.env.AI_ALLOW_MOCK_FALLBACK;
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalMockFlag === undefined) delete process.env.AI_ALLOW_MOCK_FALLBACK;
  else process.env.AI_ALLOW_MOCK_FALLBACK = originalMockFlag;
});

describe("legacy AI client production fallback policy", () => {
  it("does not silently return a mock provider in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.AI_ALLOW_MOCK_FALLBACK;
    const provider = createAiProvider({ provider: "gemini", model: "gemini-test" });
    await expect(provider.generateText({ prompt: "hi" })).rejects.toThrow("AI provider unavailable");
  });
});
