declare module "prompt-api-polyfill" {
  export type PromptApiSession = {
    prompt?: (input: string) => Promise<string>;
    promptStreaming?: (input: string) => AsyncIterable<string>;
    destroy?: () => void;
  };

  export const LanguageModel: {
    availability(options?: unknown): Promise<string>;
    create(options?: unknown): Promise<PromptApiSession>;
    __isPolyfill?: boolean;
  };
}
