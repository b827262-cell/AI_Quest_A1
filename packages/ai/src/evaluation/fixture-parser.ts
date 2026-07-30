import type { EvaluationFixtureMap } from "./runner";
import type { EvaluationSubjectResult } from "./evaluation-types";

function containsSensitiveText(value: string): boolean {
  return /(?:authorization\s*[:=]|bearer\s+[a-z0-9._-]{12,}|(?:api[_-]?key|credential[_-]?secret)\s*[:=]|(?:sk|xai)-[a-z0-9]{12,}|AIza[a-z0-9_-]{20,}|AQ\.[a-z0-9_-]{16,})/i.test(value);
}

export function parseEvaluationFixtures(input: unknown): EvaluationFixtureMap {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("fixtures must be an object");
  const result: EvaluationFixtureMap = {};
  for (const [caseId, raw] of Object.entries(input)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`fixture ${caseId} must be an object`);
    const record = raw as Record<string, unknown>;
    if (typeof record.modelCallCount !== "number" || typeof record.durationMs !== "number") throw new Error(`fixture ${caseId} is missing safe metrics`);
    if (record.answer !== undefined && typeof record.answer !== "string") throw new Error(`fixture ${caseId}.answer must be a string`);
    if (containsSensitiveText(JSON.stringify(raw))) throw new Error(`fixture ${caseId} contains sensitive material`);
    result[caseId] = {
      answer: record.answer as string | undefined,
      primaryAnswer: record.primaryAnswer as string | undefined,
      classification: record.classification as EvaluationSubjectResult["classification"],
      outcome: record.outcome as EvaluationSubjectResult["outcome"],
      confidenceLevel: record.confidenceLevel as EvaluationSubjectResult["confidenceLevel"],
      modelCallCount: record.modelCallCount,
      inputTokens: typeof record.inputTokens === "number" ? record.inputTokens : undefined,
      outputTokens: typeof record.outputTokens === "number" ? record.outputTokens : undefined,
      totalTokens: typeof record.totalTokens === "number" ? record.totalTokens : undefined,
      durationMs: record.durationMs,
      safeDiagnostics: typeof record.safeDiagnostics === "object" && record.safeDiagnostics !== null && !Array.isArray(record.safeDiagnostics) ? record.safeDiagnostics as Record<string, unknown> : undefined
    };
  }
  return result;
}
