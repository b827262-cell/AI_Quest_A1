import type { RagCitation } from "./contracts";
import type {
  LlmGenerateInput,
  LlmGenerateOutput,
  LlmProvider,
  RagProviderId,
  RetrievedChunk,
  Retriever,
  RetrieverInput
} from "./ports";

export type FakeProviderOptions = {
  model?: string;
  response?: { answer: string; citations: RagCitation[]; confidence?: "high" | "medium" | "low" };
  handler?: (input: LlmGenerateInput) => Promise<string> | string;
};

/** Deterministic provider for tests; it records metadata only, never prompts. */
export class FakeLlmProvider implements LlmProvider {
  readonly providerId: RagProviderId = "fake";
  readonly defaultModel: string;
  readonly calls: Array<{ requestId: string; promptLength: number; systemPromptLength: number }> = [];
  private readonly options: FakeProviderOptions;

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
    this.defaultModel = options.model ?? "fake-rag-model";
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateOutput> {
    this.calls.push({
      requestId: input.requestId,
      promptLength: input.userPrompt.length,
      systemPromptLength: input.systemPrompt.length
    });
    const text = this.options.handler
      ? await this.options.handler(input)
      : JSON.stringify({
          answer: this.options.response?.answer ?? "No fake answer configured.",
          citations: this.options.response?.citations ?? [],
          confidence: this.options.response?.confidence ?? "low"
        });
    return { text, model: input.model ?? this.defaultModel, latencyMs: 0 };
  }
}

export class FakeRetriever implements Retriever {
  readonly calls: Array<{ requestId: string; queryLength: number; topK: number }> = [];
  private readonly chunks: readonly RetrievedChunk[];

  constructor(chunks: readonly RetrievedChunk[]) {
    this.chunks = chunks.map((chunk) => ({ ...chunk }));
  }

  async retrieve(input: RetrieverInput): Promise<readonly RetrievedChunk[]> {
    this.calls.push({ requestId: input.requestId, queryLength: input.query.length, topK: input.topK });
    return this.chunks.slice(0, input.topK).map((chunk) => ({ ...chunk }));
  }
}
