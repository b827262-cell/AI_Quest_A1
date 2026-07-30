import type {
  AiComplexity,
  AiProviderId,
  AiSubject,
  AiTaskType,
  RoutingDecision
} from "./ai-types";

/**
 * Rule-based router. The first rule whose `match` predicate fires determines
 * the preferred provider + fallbacks. Rules live in a config array so the
 * strategy can be changed without touching the decision code (spec §4 —
 * "請設計成設定檔或資料庫規則，不可寫死在 Controller").
 *
 * Classification uses lightweight keyword heuristics — deliberately not an LLM
 * call — so routing itself never spends budget or needs an API key.
 */

export type RouterRule = {
  name: string;
  match: (ctx: ClassificationContext) => boolean;
  preferredProvider: AiProviderId;
  fallbackProviders: AiProviderId[];
  complexityBias?: AiComplexity;
  reason: string;
  /**
   * Logical model id to prefer for matching requests (e.g. "gpt-5.6-terra").
   * Optional; when absent the provider's default model is used. Sol is NOT
   * wired here — it is reserved for orchestrator-level arbitration only.
   */
  preferredLogicalModel?: string;
  /**
   * Whether this rule marks a request as eligible for a second-model
   * verification pass. The orchestrator still gates on pool utilization.
   */
  secondModelEligible?: boolean;
  /** Reason the rule sets (or clears) second-model eligibility. */
  secondModelReason?: string;
};

export type ClassificationContext = {
  prompt: string;
  subject: AiSubject;
  taskType: AiTaskType;
  complexity: AiComplexity;
};

export type RouterConfig = {
  /** Ordered rules; first match wins. */
  rules: RouterRule[];
  /** Fallbacks used when no rule matches. */
  defaultPreferred: AiProviderId;
  defaultFallbacks: AiProviderId[];
  /** Provider ids considered "router-safe" (the last-resort backstop). */
  backstopProvider: AiProviderId;
};

/** Default routing rules — mirrors the spec §4 strategy table. */
export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  rules: [
    {
      name: "math-or-calculation",
      // Spec §4: 數學 → OpenAI. Math/calculation routes to OpenAI at any
      // complexity. High-complexity *reasoning* from math/science also lands here.
      match: (c) =>
        c.subject === "math" ||
        c.taskType === "calculation" ||
        (c.subject === "science" && c.complexity === "high"),
      preferredProvider: "openai",
      fallbackProviders: ["gemini", "qwen", "mock"],
      complexityBias: "high",
      reason: "數學／高複雜推理 → OpenAI"
    },
    {
      name: "programming",
      match: (c) => c.subject === "programming" || c.taskType === "coding",
      preferredProvider: "openai",
      fallbackProviders: ["gemini", "mock"],
      reason: "程式 → OpenAI"
    },
    {
      name: "long-text-humanities",
      match: (c) =>
        c.subject === "humanities" ||
        c.subject === "language" ||
        c.taskType === "summarization" ||
        c.taskType === "writing",
      preferredProvider: "kimi",
      fallbackProviders: ["qwen", "gemini", "mock"],
      reason: "長文／文科／資料整理 → Kimi"
    },
    {
      name: "general-zh-education",
      match: (c) =>
        c.subject === "general" ||
        c.taskType === "question_answering" ||
        c.taskType === "explanation",
      preferredProvider: "qwen",
      fallbackProviders: ["gemini", "kimi", "mock"],
      reason: "一般問答／中文教育 → Qwen"
    },
    {
      name: "science",
      match: (c) => c.subject === "science",
      preferredProvider: "gemini",
      fallbackProviders: ["openai", "qwen", "mock"],
      reason: "自然科學 → Gemini"
    }
  ],
  defaultPreferred: "qwen",
  defaultFallbacks: ["gemini", "mock"],
  backstopProvider: "mock"
};

/** Keyword banks used by the rule-free classifier below. */
const SUBJECT_KEYWORDS: Record<Exclude<AiSubject, "general" | "unknown">, RegExp> = {
  math: /數學|方程|幾何|微積分|積分|微分|機率|統計|equation|integral|derivative|algebra|calculus|math/i,
  science: /物理|化學|生物|地球科學|自然|physics|chemistry|biology|science/i,
  programming: /程式|程式設計|程式碼|javascript|typescript|python|java|rust|code|演算法|algorithm|debug/i,
  language: /英文|翻譯|文法|grammar|translation|english|語言|language/i,
  humanities: /歷史|地理|公民|社會|文學|哲學|history|geography|literature|philosophy/i
};

const TASK_KEYWORDS: Record<Exclude<AiTaskType, "unknown">, RegExp> = {
  // Calculation requires an arithmetic cue; bare "解" (used in 解釋/了解) is
  // intentionally excluded to avoid false positives.
  calculation: /計算|求解|解方程|算出|求出|calculate|compute|solve|equation/i,
  translation: /翻譯|translate|translation/i,
  summarization: /摘要|總結|重點|summarize|summary/i,
  writing: /寫作|作文|改寫|write|draft|essay/i,
  coding: /程式|code|implement|實作|refactor/i,
  explanation: /解釋|說明|為什麼|explain|why|what is/i,
  question_answering: /請問|\?|？|如何|怎麼|how to|how do/i
};

/** Estimate token-equivalent length without calling a tokenizer. */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~3 chars/token is a reasonable blend for mixed CJK + latin content.
  return Math.max(1, Math.ceil(text.length / 3));
}

export function classifySubject(prompt: string): AiSubject {
  for (const key of Object.keys(SUBJECT_KEYWORDS) as Array<Exclude<AiSubject, "general" | "unknown">>) {
    if (SUBJECT_KEYWORDS[key].test(prompt)) return key;
  }
  return "general";
}

export function classifyTask(prompt: string): AiTaskType {
  for (const key of Object.keys(TASK_KEYWORDS) as Array<Exclude<AiTaskType, "unknown">>) {
    if (TASK_KEYWORDS[key].test(prompt)) return key;
  }
  return "question_answering";
}

export function classifyComplexity(prompt: string, taskType: AiTaskType): AiComplexity {
  const tokens = estimateTokens(prompt);
  if (taskType === "calculation" || taskType === "coding") {
    return tokens > 60 ? "high" : "medium";
  }
  if (tokens >= 90) return "high";
  if (tokens >= 25) return "medium";
  return "low";
}

/** Run the classifier over a raw prompt. */
export function classify(prompt: string): {
  subject: AiSubject;
  taskType: AiTaskType;
  complexity: AiComplexity;
} {
  const subject = classifySubject(prompt);
  const taskType = classifyTask(prompt);
  const complexity = classifyComplexity(prompt, taskType);
  return { subject, taskType, complexity };
}

/**
 * Produce a routing decision for a prompt. `availableProviderIds` filters the
 * rule fallbacks down to providers that are currently registered + available,
 * guaranteeing the backstop (mock) is always reachable (spec §4 fallback rules).
 */
export function routePrompt(
  prompt: string,
  options?: {
    config?: RouterConfig;
    availableProviderIds?: AiProviderId[];
    preferredProvider?: AiProviderId;
    preferredModel?: string;
  }
): RoutingDecision {
  const config = options?.config ?? DEFAULT_ROUTER_CONFIG;
  const available = new Set(options?.availableProviderIds ?? []);
  // Mock is always treated as available so the backstop is never empty.
  available.add(config.backstopProvider);

  const classification = classify(prompt);
  const ctx: ClassificationContext = { prompt, ...classification };

  let chosen: Pick<
    RoutingDecision,
    "preferredProvider" | "fallbackProviders" | "reason" | "preferredLogicalModel" | "secondModelEligible" | "secondModelReason"
  > | null = null;

  let matchedRule: RouterRule | undefined;
  for (const rule of config.rules) {
    if (rule.match(ctx)) {
      chosen = {
        preferredProvider: rule.preferredProvider,
        fallbackProviders: rule.fallbackProviders,
        reason: rule.reason,
        preferredLogicalModel: rule.preferredLogicalModel,
        secondModelEligible: rule.secondModelEligible,
        secondModelReason: rule.secondModelReason
      };
      matchedRule = rule;
      break;
    }
  }

  if (!chosen) {
    chosen = {
      preferredProvider: config.defaultPreferred,
      fallbackProviders: config.defaultFallbacks,
      reason: "未命中特定規則 → 預設 Provider"
    };
  }

  // Filter to available providers, preserving order; ensure backstop presence.
  const ordered = [chosen.preferredProvider, ...chosen.fallbackProviders];
  const seen = new Set<AiProviderId>();
  const chain: AiProviderId[] = [];
  for (const id of ordered) {
    if (available.has(id) && !seen.has(id)) {
      chain.push(id);
      seen.add(id);
    }
  }
  if (chain.length === 0 || !chain.includes(config.backstopProvider)) {
    if (!seen.has(config.backstopProvider)) chain.push(config.backstopProvider);
  }

  const preferred = chain.shift() ?? config.backstopProvider;

  // Default second-model eligibility: medium+ complexity or calculation/coding
  // tasks benefit from verification, per spec §2. Explicit rule flags override.
  const defaultSecondModelEligible =
    classification.complexity === "high" ||
    classification.complexity === "medium" ||
    classification.taskType === "calculation" ||
    classification.taskType === "coding";
  const secondModelEligible = matchedRule?.secondModelEligible ?? defaultSecondModelEligible;
  const secondModelReason =
    matchedRule?.secondModelReason ??
    (secondModelEligible ? "中高難度／計算／程式 → 允許第二模型驗證" : "低難度一般問題 → 不需第二模型");

  return {
    subject: classification.subject,
    taskType: classification.taskType,
    complexity: classification.complexity,
    preferredProvider: options?.preferredProvider ?? preferred,
    preferredModel: options?.preferredModel,
    fallbackProviders: chain,
    reason: chosen.reason,
    preferredLogicalModel: chosen.preferredLogicalModel,
    secondModelEligible,
    secondModelReason
  };
}
