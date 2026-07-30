import { AiGatewayError, type AiGenerateRequest, type AiGenerateResult, type AiProviderId, type AiSubject } from "../ai-types";
import type { GatewayAiProvider } from "../provider.interface";

/**
 * Deterministic gateway provider. Always available (no key required), zero
 * cost, and produces subject-aware canned answers so the full gateway flow
 * (routing → budget → logging → analytics) runs end to end without any real
 * API key (spec §13.2).
 *
 * Token counts are *estimated* from character length — mock never bills.
 */
export class MockGatewayProvider implements GatewayAiProvider {
  readonly providerId: AiProviderId = "mock";
  readonly defaultModel: string;

  constructor(model = "mock-v1") {
    this.defaultModel = model;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const startedAt = Date.now();
    if (!request.prompt || request.prompt.trim().length === 0) {
      throw new AiGatewayError(
        "AI_INVALID_INPUT",
        "AI 服務目前暫時無法使用，請稍後再試。",
        { internalMessage: "mock provider received empty prompt" }
      );
    }

    const subject: AiSubject = request.subject ?? "general";
    const answer = buildMockAnswer(request.prompt, subject);
    // Rough heuristic estimate so usage logging has non-zero numbers for mock too.
    const inputTokens = estimateTokens(request.systemPrompt ?? "") + estimateTokens(request.prompt);
    const outputTokens = estimateTokens(answer);

    return {
      provider: "mock",
      model: request.model ?? this.defaultModel,
      answer,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      usageSource: "system_estimated",
      latencyMs: Date.now() - startedAt,
      estimatedCostMicroUsd: 0,
      finishReason: "stop",
      diagnostics: {
        provider: "mock",
        model: request.model ?? this.defaultModel,
        transport: "json",
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        configuredMaxOutputTokens: request.maxOutputTokens,
        finishReason: "stop",
        requestDurationMs: Date.now() - startedAt,
        streamEndedNormally: true,
        lastChunk: null
      }
    };
  }
}

/** ~4 chars per token is a common approximation for mixed CJK + latin text. */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildMockAnswer(prompt: string, subject: AiSubject): string {
  const trimmed = prompt.trim();
  const snippet = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
  if (/排序|sort|bubble|insertion|merge|quick/i.test(trimmed)) {
    return [
      "（mock 學習助教）以下是四種排序法的精簡完整示範：",
      "1. 泡沫排序（Bubble Sort）：反覆比較相鄰元素並交換逆序項，較大的元素會逐輪移到尾端；最佳 O(n)（已有序且有提前停止），平均與最差 O(n²)。",
      "2. 插入排序（Insertion Sort）：依序取出下一項，向左移動較大的已排序元素後插入；最佳 O(n)，平均與最差 O(n²)。",
      "3. 合併排序（Merge Sort）：將資料分割成子陣列，遞迴排序後再合併有序子陣列；最佳、平均與最差皆 O(n log n)。",
      "4. 快速排序（Quick Sort）：選取 pivot 分割小於與大於 pivot 的區段，再遞迴處理；平均 O(n log n)，最差 O(n²)，最佳 O(n log n)。",
      "摘要：泡沫與插入排序實作簡單但平均 O(n²)；合併排序時間穩定；快速排序平均快速但需注意 pivot 選擇。",
      "這是公開體驗版的 Mock 示範，不代表正式 AI 模型結果。"
    ].join("\n");
  }
  switch (subject) {
    case "math":
      return `（mock 數學助教）我先把你的問題拆成「已知條件、要找的量、可使用的關係式」三步：\n${snippet}\n這是公開體驗版的示範回答，登入後可獲得逐步計算與完整解析。`;
    case "programming":
      return `（mock 程式助教）建議先確認輸入與輸出，再將問題拆成可測試的小函式：\n${snippet}\n登入後可保存完整範例與學習紀錄。`;
    case "science":
      return `（mock 自然助教）先找出關鍵概念與因果關係，再用一個小例子驗證：\n${snippet}`;
    case "language":
      return `（mock 語文助教）先把句構與重點詞彙標示出來，再逐步釐清意義：\n${snippet}`;
    case "humanities":
      return `（mock 文科助教）我先把問題脈絡整理出來，列出不同觀點再做比較：\n${snippet}`;
    default:
      return `（mock 學習助教）我先把你的問題整理成學習方向 — 找出關鍵概念、列出已知條件，再用一個小例子驗證理解：\n${snippet}\n這是公開體驗版的簡化回答；登入後可連結教材、保存答案並繼續追問。`;
  }
}
