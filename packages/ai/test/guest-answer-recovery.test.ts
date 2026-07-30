import { describe, expect, it } from "vitest";
import { AiGateway, AiGatewayError, MockGatewayProvider } from "../src";
import type { GatewayAiProvider } from "../src/gateway/provider.interface";
import type { AiGenerateRequest, AiGenerateResult, AiProviderId } from "../src/gateway/ai-types";

class RecoveryProvider implements GatewayAiProvider {
  readonly providerId: AiProviderId = "openai";
  readonly defaultModel = "recovery-test";
  calls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.calls += 1;
    const first = this.calls === 1;
    const answer = first
      ? "1. Bubble Sort：逐回合交換相鄰逆序元素。\n2. Insertion Sort：將下一個元素插入已排序區間。"
      : "3. Merge Sort：分割後遞迴排序，再合併兩個有序區間。\n4. Quick Sort：選 pivot 分割，遞迴處理左右區間。\n\n| 方法 | 平均時間 |\n|---|---|\n| 四種排序 | 依方法而異 |";
    return {
      provider: this.providerId,
      model: request.model ?? this.defaultModel,
      answer,
      inputTokens: 20,
      outputTokens: 30,
      totalTokens: 50,
      latencyMs: 1,
      finishReason: first ? "length" : "stop"
    };
  }
}

class NormalProvider extends RecoveryProvider {
  override async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.calls += 1;
    return {
      provider: this.providerId,
      model: request.model ?? this.defaultModel,
      answer: "Bubble Sort、Insertion Sort、Merge Sort、Quick Sort 都已完整說明。",
      latencyMs: 1,
      finishReason: "stop"
    };
  }
}

class FailingContinuationProvider extends RecoveryProvider {
  override async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    if (this.calls >= 1) {
      this.calls += 1;
      throw new AiGatewayError("AI_PROVIDER_UNAVAILABLE", "safe", {
        failedProvider: this.providerId,
        retryable: false
      });
    }
    return super.generate(request);
  }
}

function makeGateway(provider: GatewayAiProvider) {
  return new AiGateway({
    providers: new Map([[provider.providerId, provider]]),
    forceProvider: provider.providerId,
    requestTimeoutMs: 1000,
    maxRetries: 0,
    maxOutputTokens: 128,
    maxInputChars: 2000
  });
}

describe("guest answer completion recovery", () => {
  it("covers all four sorting subtopics after one length continuation", async () => {
    const provider = new RecoveryProvider();
    const output = await makeGateway(provider).run({
      requestId: "guest-recovery",
      prompt: "請說明：1. Bubble Sort 2. Insertion Sort 3. Merge Sort 4. Quick Sort"
    });

    expect(provider.calls).toBe(2);
    expect(output.result.answer).toContain("Bubble Sort");
    expect(output.result.answer).toContain("Insertion Sort");
    expect(output.result.answer).toContain("Merge Sort");
    expect(output.result.answer).toContain("Quick Sort");
    expect(output.result.diagnostics?.continuationAttempts).toBe(1);
    expect(output.result.completion?.complete).toBe(true);
  });

  it("does not issue a second provider request after a normal stop", async () => {
    const provider = new NormalProvider();
    const output = await makeGateway(provider).run({
      requestId: "guest-normal",
      prompt: "請簡述四種排序法"
    });

    expect(provider.calls).toBe(1);
    expect(output.result.finishReason).toBe("stop");
  });

  it("does not mark a first segment complete when its continuation fails", async () => {
    const provider = new FailingContinuationProvider();
    await expect(makeGateway(provider).run({
      requestId: "guest-continuation-failed",
      prompt: "請說明：1. Bubble Sort 2. Insertion Sort 3. Merge Sort 4. Quick Sort"
    })).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    expect(provider.calls).toBe(2);
  });

  it("keeps mock mode explicit when the deterministic provider is used", async () => {
    const output = await new AiGateway({
      providers: new Map([["mock", new MockGatewayProvider()]]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 128,
      maxInputChars: 2000
    }).run({ requestId: "guest-mock", prompt: "請解釋排序" });

    expect(output.result.provider).toBe("mock");
    expect(output.result.answer).toContain("mock");
  });
});
