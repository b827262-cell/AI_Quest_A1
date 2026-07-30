import { type AiProviderId } from "../ai-types";
import { OpenAiGatewayProvider } from "./openai.provider";

/** Z.AI's general OpenAI-compatible API. */
export class ZaiGatewayProvider extends OpenAiGatewayProvider {
  override readonly providerId: AiProviderId = "zai";

  constructor(options?: { apiKey?: string; baseUrl?: string; model?: string }) {
    super({
      apiKey: options?.apiKey,
      baseUrl: normalizeZaiBaseUrl(options?.baseUrl),
      model: options?.model ?? "glm-5.1"
    });
  }
}

/**
 * Accept either Z.AI's documented base URL with or without a trailing slash.
 * If an operator pastes the host/path without /v4, add it once; if /v4 is
 * already present, do not create /v4/v4. Endpoint suffixes are owned by the
 * provider adapter and are never accepted as part of the stored base URL.
 */
export function normalizeZaiBaseUrl(value?: string): string {
  const fallback = "https://api.z.ai/api/paas/v4";
  let base = (value?.trim() || fallback).replace(/\/+$/, "");
  base = base.replace(/\/chat\/completions$/i, "").replace(/\/(?:v4\/)+v4$/i, "/v4");
  if (/^https:\/\/api\.z\.ai\/api\/(?:paas|coding\/paas)$/i.test(base)) base += "/v4";
  return base;
}
