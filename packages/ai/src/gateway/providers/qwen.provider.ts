import { type AiProviderId } from "../ai-types";
import type { DnsResolver } from "../../rag/safe-url";
import type { ProviderTransport } from "../provider-transport";
import { OpenAiGatewayProvider } from "./openai.provider";

/**
 * Qwen (DashScope, OpenAI-compatible mode) provider. Model name + base URL
 * are configurable; unavailable when the key is unset.
 */
export class QwenGatewayProvider extends OpenAiGatewayProvider {
  override readonly providerId: AiProviderId = "qwen";

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    /** Injectable pinned transport (default: pinnedFetch). Tests only. */
    transport?: ProviderTransport;
    /** Injectable DNS resolver for the pinned transport. Tests only. */
    dnsResolver?: DnsResolver;
  }) {
    super({
      apiKey: options?.apiKey,
      baseUrl: options?.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
      transport: options?.transport,
      dnsResolver: options?.dnsResolver,
      model: options?.model ?? "qwen-turbo"
    });
  }
}
