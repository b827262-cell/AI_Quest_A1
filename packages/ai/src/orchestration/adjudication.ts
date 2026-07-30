import type { VerificationIssue } from "./verification-result";

export type AdjudicationDecision =
  | "primary_correct"
  | "verification_correct"
  | "merged_answer"
  | "insufficient_information";

export type AdjudicationReasonCategory =
  | "factual"
  | "calculation"
  | "logic"
  | "code"
  | "safety"
  | "missing_information"
  | "other";

export interface AdjudicationResult {
  decision: AdjudicationDecision;
  finalAnswer: string;
  confidence?: number;
  reasonCategory?: AdjudicationReasonCategory;
}

export type AdjudicationParseFailure =
  | "empty"
  | "invalid_json"
  | "not_object"
  | "unknown_field"
  | "invalid_decision"
  | "invalid_answer"
  | "invalid_confidence"
  | "invalid_reason_category";

export type AdjudicationParseResult =
  | { ok: true; value: AdjudicationResult }
  | { ok: false; reason: AdjudicationParseFailure };

const DECISIONS = new Set<AdjudicationDecision>([
  "primary_correct",
  "verification_correct",
  "merged_answer",
  "insufficient_information"
]);
const CATEGORIES = new Set<AdjudicationReasonCategory>([
  "factual",
  "calculation",
  "logic",
  "code",
  "safety",
  "missing_information",
  "other"
]);
const ALLOWED_FIELDS = new Set(["decision", "finalAnswer", "confidence", "reasonCategory"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAdjudicationResult(raw: string): AdjudicationParseResult {
  if (!raw.trim()) return { ok: false, reason: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "not_object" };
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_FIELDS.has(key)) return { ok: false, reason: "unknown_field" };
  }
  if (typeof parsed.decision !== "string" || !DECISIONS.has(parsed.decision as AdjudicationDecision)) {
    return { ok: false, reason: "invalid_decision" };
  }
  if (
    typeof parsed.finalAnswer !== "string" ||
    parsed.finalAnswer.trim().length === 0 ||
    parsed.finalAnswer.length > 20_000
  ) {
    return { ok: false, reason: "invalid_answer" };
  }
  if (
    parsed.confidence !== undefined &&
    (typeof parsed.confidence !== "number" ||
      !Number.isFinite(parsed.confidence) ||
      parsed.confidence < 0 ||
      parsed.confidence > 1)
  ) {
    return { ok: false, reason: "invalid_confidence" };
  }
  if (
    parsed.reasonCategory !== undefined &&
    (typeof parsed.reasonCategory !== "string" ||
      !CATEGORIES.has(parsed.reasonCategory as AdjudicationReasonCategory))
  ) {
    return { ok: false, reason: "invalid_reason_category" };
  }
  return {
    ok: true,
    value: {
      decision: parsed.decision as AdjudicationDecision,
      finalAnswer: parsed.finalAnswer.trim(),
      confidence: parsed.confidence,
      reasonCategory: parsed.reasonCategory as AdjudicationReasonCategory | undefined
    }
  };
}

export function buildAdjudicationPrompt(
  question: string,
  primaryAnswer: string,
  issues: VerificationIssue[]
): string {
  const safeIssues = issues.map((issue) => ({
    category: issue.category,
    severity: issue.severity,
    description: issue.description
  }));
  return [
    "你是答案裁決器。請只輸出指定 JSON，不要輸出 Markdown、解釋或 Chain of Thought。",
    'schema: {"decision":"primary_correct|verification_correct|merged_answer|insufficient_information","finalAnswer":"安全且完整的單一答案","confidence":0..1,"reasonCategory":"factual|calculation|logic|code|safety|missing_information|other"}',
    "若資訊不足，必須選 insufficient_information，不得捏造確定事實。",
    "使用者問題：",
    question,
    "Primary 答案：",
    primaryAnswer,
    "Verification issues（僅結構化問題）：",
    JSON.stringify(safeIssues)
  ].join("\n");
}
