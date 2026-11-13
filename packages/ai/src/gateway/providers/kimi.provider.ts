import { type AiProviderId } from "../ai-types";
import type { DnsResolver } from "../../rag/safe-url";
import type { ProviderTransport } from "../provider-transport";
import { OpenAiGatewayProvider } from "./openai.provider";

/**
 * Kimi (Moonshot) provider — OpenAI Chat Completions compatible. The model
 * name and base URL are configurable so they are never hardcoded in routing
 * logic (spec §3, §11).
 */
export class KimiGatewayProvider extends OpenAiGatewayProvider {
  override readonly providerId: AiProviderId = "kimi";

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
      baseUrl: options?.baseUrl ?? "https://api.moonshot.cn/v1",
      transport: options?.transport,
      dnsResolver: options?.dnsResolver,
      model: options?.model ?? "moonshot-v1-8k"
    });
  }
}
