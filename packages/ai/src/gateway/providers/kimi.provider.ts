import { type AiProviderId } from "../ai-types";
import { OpenAiGatewayProvider } from "./openai.provider";

/**
 * Kimi (Moonshot) provider — OpenAI Chat Completions compatible. The model
 * name and base URL are configurable so they are never hardcoded in routing
 * logic (spec §3, §11).
 */
export class KimiGatewayProvider extends OpenAiGatewayProvider {
  override readonly providerId: AiProviderId = "kimi";

  constructor(options?: { apiKey?: string; baseUrl?: string; model?: string }) {
    super({
      apiKey: options?.apiKey,
      baseUrl: options?.baseUrl ?? "https://api.moonshot.cn/v1",
      model: options?.model ?? "moonshot-v1-8k"
    });
  }
}
