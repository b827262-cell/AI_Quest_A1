import type { AiGenerateInput, AiProvider } from "../provider";

/**
 * Minimal Gemini provider using the public generateContent REST endpoint.
 * The API key is supplied from server-side config only and never hardcoded.
 */
export class GeminiAiProvider implements AiProvider {
  readonly name = "gemini" as const;
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model = "gemini-3.5-flash") {
    if (!apiKey) {
      throw new Error("GeminiAiProvider requires GEMINI_API_KEY");
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateText(input: AiGenerateInput): Promise<string> {
    const model = input.model || this.model;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const body = {
      systemInstruction: input.system
        ? { parts: [{ text: input.system }] }
        : undefined,
      contents: [{ role: "user", parts: [{ text: input.prompt }] }],
      generationConfig: {
        temperature: input.temperature ?? 0.4
      }
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: input.signal
    });

    if (!res.ok) {
      await res.text().catch(() => "");
      throw new Error(`Gemini request failed: ${res.status}`);
    }

    let data: { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new Error("Gemini provider returned invalid JSON");
    }
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p.text ?? "").join("").trim();
  }
}
