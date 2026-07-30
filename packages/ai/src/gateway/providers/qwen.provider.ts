import { type AiProviderId } from "../ai-types";
import { OpenAiGatewayProvider } from "./openai.provider";

/**
 * Qwen (DashScope, OpenAI-compatible mode) provider. Model name + base URL
 * are configurable; unavailable when the key is unset.
 */
export class QwenGatewayProvider extends OpenAiGatewayProvider {
  override readonly providerId: AiProviderId = "qwen";

  constructor(options?: { apiKey?: string; baseUrl?: string; model?: string }) {
    super({
      apiKey: options?.apiKey,
      baseUrl: options?.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: options?.model ?? "qwen-turbo"
    });
  }
}
