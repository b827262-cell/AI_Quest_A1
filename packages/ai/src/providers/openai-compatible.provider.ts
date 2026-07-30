import type { AiGenerateInput, AiProvider } from "../provider";

/**
 * Provider for any OpenAI Chat Completions compatible endpoint
 * (OpenAI, OpenRouter, local gateways, etc). Key/baseUrl come from
 * server-side config only.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = "openai-compatible" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.openai.com/v1", model = "gpt-4o-mini") {
    if (!apiKey) {
      throw new Error("OpenAiCompatibleProvider requires OPENAI_API_KEY");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
  }

  async generateText(input: AiGenerateInput): Promise<string> {
    const messages = [];
    if (input.system) messages.push({ role: "system", content: input.system });
    messages.push({ role: "user", content: input.prompt });

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: input.model || this.model,
        temperature: input.temperature ?? 0.4,
        messages
      }),
      signal: input.signal
    });

    if (!res.ok) {
      await res.text().catch(() => "");
      throw new Error(`OpenAI-compatible request failed: ${res.status}`);
    }

    let data: { choices?: { message?: { content?: string } }[] };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new Error("OpenAI-compatible provider returned invalid JSON");
    }
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }
}
