import { loadAiConfig, type AiClientConfig, type AiProvider } from "./provider";
import { MockAiProvider } from "./providers/mock.provider";
import { GeminiAiProvider } from "./providers/gemini.provider";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.provider";

/**
 * Factory that builds the configured legacy provider. Mock fallback follows
 * the same production policy as the Phase 2 Gateway.
 */
export function createAiProvider(config: AiClientConfig = loadAiConfig()): AiProvider {
  const allowMockFallback =
    process.env.AI_ALLOW_MOCK_FALLBACK === undefined
      ? process.env.NODE_ENV !== "production"
      : process.env.AI_ALLOW_MOCK_FALLBACK === "true";
  const unavailable = () => new UnavailableAiProvider(config.model);
  switch (config.provider) {
    case "gemini":
      if (!config.geminiApiKey) {
        if (allowMockFallback) return new MockAiProvider(config.model);
        return unavailable();
      }
      return new GeminiAiProvider(config.geminiApiKey, config.model);

    case "openai-compatible":
      if (!config.openaiApiKey) {
        if (allowMockFallback) return new MockAiProvider(config.model);
        return unavailable();
      }
      return new OpenAiCompatibleProvider(config.openaiApiKey, config.openaiBaseUrl, config.model);

    case "mock":
    default:
      return allowMockFallback ? new MockAiProvider(config.model) : unavailable();
  }
}

class UnavailableAiProvider implements AiProvider {
  readonly name = "openai-compatible" as const;
  constructor(readonly model: string) {}
  async generateText(): Promise<string> {
    throw new Error("AI provider unavailable");
  }
}

export class AiClient {
  readonly provider: AiProvider;

  constructor(config?: AiClientConfig) {
    this.provider = createAiProvider(config);
  }

  get name() {
    return this.provider.name;
  }

  get model() {
    return this.provider.model;
  }

  generateText(input: Parameters<AiProvider["generateText"]>[0]) {
    return this.provider.generateText(input);
  }
}
