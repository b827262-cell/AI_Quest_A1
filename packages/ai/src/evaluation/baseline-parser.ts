import type { EvaluationBaseline } from "./baseline";

export function parseEvaluationBaseline(input: unknown): EvaluationBaseline {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("baseline must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.datasetId !== "string" || typeof value.datasetVersion !== "number" || typeof value.executionMode !== "string" || typeof value.summary !== "object" || value.summary === null) throw new Error("baseline has an invalid safe shape");
  if (/(?:authorization|bearer|api[_-]?key|credential[_-]?secret)\s*[:=]/i.test(JSON.stringify(input))) throw new Error("baseline contains sensitive material");
  return value as unknown as EvaluationBaseline;
}
