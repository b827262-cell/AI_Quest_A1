export type AiProviderName = "mock" | "gemini" | "openai-compatible";

export interface AiGenerateInput {
  system?: string;
  prompt: string;
  /** Optional override of the configured model. */
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  generateText(input: AiGenerateInput): Promise<string>;
}

export interface AiClientConfig {
  provider: AiProviderName;
  model: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}

/**
 * Build AI client config from environment. API keys are never hardcoded;
 * they are only read from the process environment on the server side.
 */
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiClientConfig {
  const provider = (env.AI_PROVIDER as AiProviderName) || "mock";
  return {
    provider,
    model: env.AI_MODEL || "gemini-3.5-flash",
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    openaiBaseUrl: env.OPENAI_BASE_URL || undefined
  };
}
