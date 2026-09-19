declare module "prompt-api-polyfill" {
  export type PromptApiOptions = { signal?: AbortSignal };

  export type PromptApiSession = {
    prompt?: (input: string, options?: PromptApiOptions) => Promise<string>;
    promptStreaming?: (input: string, options?: PromptApiOptions) => AsyncIterable<string>;
    destroy?: () => void;
  };

  export const LanguageModel: {
    availability(options?: unknown): Promise<string>;
    create(options?: unknown): Promise<PromptApiSession>;
    __isPolyfill?: boolean;
  };
}
