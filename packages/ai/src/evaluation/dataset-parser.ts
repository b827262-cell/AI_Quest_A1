import type { EvaluationCase, EvaluationCategory, EvaluationDataset, EvaluationExpectation } from "./evaluation-types";

const categories = new Set<EvaluationCategory>(["programming", "mathematics", "knowledge", "unknown"]);
const difficulties = new Set(["easy", "medium", "hard"]);
const sources = new Set(["synthetic", "curated", "regression"]);
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class EvaluationDatasetError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid evaluation dataset: ${issues.join("; ")}`);
    this.name = "EvaluationDatasetError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsSensitiveText(value: string): boolean {
  return /(?:authorization\s*:\s*bearer|bearer\s+[a-z0-9._-]{12,}|(?:api[_-]?key|credential[_-]?secret)\s*[:=]|(?:sk|xai)-[a-z0-9]{12,}|AIza[a-z0-9_-]{20,}|AQ\.[a-z0-9_-]{16,})/i.test(value);
}

function validateExpectation(value: unknown, path: string, issues: string[]): value is EvaluationExpectation {
  if (!isRecord(value) || typeof value.kind !== "string") {
    issues.push(`${path}.kind must be valid`);
    return false;
  }
  switch (value.kind) {
    case "exact":
      if (!Array.isArray(value.acceptedAnswers) || value.acceptedAnswers.length === 0 || value.acceptedAnswers.some((item) => typeof item !== "string" || item.length === 0)) {
        issues.push(`${path}.acceptedAnswers must not be empty`);
        return false;
      }
      return true;
    case "numeric":
      if (typeof value.expectedValue !== "number" || !Number.isFinite(value.expectedValue) || typeof value.tolerance !== "number" || !Number.isFinite(value.tolerance) || value.tolerance < 0) {
        issues.push(`${path}.numeric values must be finite and tolerance non-negative`);
        return false;
      }
      return true;
    case "required_concepts":
      if (!Array.isArray(value.required) || value.required.length === 0 || value.required.some((item) => typeof item !== "string" || item.trim() === "")) {
        issues.push(`${path}.required must not be empty`);
        return false;
      }
      if (value.minimumRequired !== undefined && (typeof value.minimumRequired !== "number" || value.minimumRequired < 1 || value.minimumRequired > value.required.length)) {
        issues.push(`${path}.minimumRequired is invalid`);
        return false;
      }
      return true;
    case "programming_analysis":
      if (!Array.isArray(value.requiredFindings) || value.requiredFindings.length === 0 || value.requiredFindings.some((item) => typeof item !== "string" || item.trim() === "")) {
        issues.push(`${path}.requiredFindings must not be empty`);
        return false;
      }
      return true;
    case "classification":
      if (typeof value.expectedCategory !== "string" || !categories.has(value.expectedCategory as EvaluationCategory)) {
        issues.push(`${path}.expectedCategory is invalid`);
        return false;
      }
      return true;
    case "safety":
      if (value.mustNotContain !== undefined && (!Array.isArray(value.mustNotContain) || value.mustNotContain.some((item) => typeof item !== "string"))) {
        issues.push(`${path}.mustNotContain is invalid`);
        return false;
      }
      return true;
    default:
      issues.push(`${path}.kind is unsupported`);
      return false;
  }
}

export function parseEvaluationDataset(input: unknown): EvaluationDataset {
  const issues: string[] = [];
  if (!isRecord(input)) throw new EvaluationDatasetError(["dataset must be an object"]);
  if (typeof input.id !== "string" || !idPattern.test(input.id)) issues.push("id must use the safe case-id format");
  if (!Number.isInteger(input.version) || (input.version as number) <= 0) issues.push("version must be a positive integer");
  if (!Array.isArray(input.cases)) issues.push("cases must be an array");
  const cases: EvaluationCase[] = [];
  const ids = new Set<string>();
  if (Array.isArray(input.cases)) {
    input.cases.forEach((raw, index) => {
      const path = `cases[${index}]`;
      if (!isRecord(raw)) {
        issues.push(`${path} must be an object`);
        return;
      }
      const id = typeof raw.id === "string" ? raw.id : "";
      if (!id || !idPattern.test(id)) issues.push(`${path}.id is invalid`);
      if (ids.has(id)) issues.push(`${path}.id is duplicated`);
      ids.add(id);
      if (!Number.isInteger(raw.version) || (raw.version as number) <= 0) issues.push(`${path}.version is invalid`);
      if (typeof raw.category !== "string" || !categories.has(raw.category as EvaluationCategory)) issues.push(`${path}.category is invalid`);
      if (typeof raw.difficulty !== "string" || !difficulties.has(raw.difficulty)) issues.push(`${path}.difficulty is invalid`);
      if (typeof raw.question !== "string" || raw.question.trim() === "") issues.push(`${path}.question must not be empty`);
      if (typeof raw.question === "string" && containsSensitiveText(raw.question)) issues.push(`${path}.question contains sensitive material`);
      if (typeof raw.source !== "string" || !sources.has(raw.source)) issues.push(`${path}.source is invalid`);
      const expectation = validateExpectation(raw.expected, `${path}.expected`, issues);
      if (expectation && containsSensitiveText(JSON.stringify(raw.expected))) issues.push(`${path}.expected contains sensitive material`);
      if (expectation && id && idPattern.test(id) && Number.isInteger(raw.version) && categories.has(raw.category as EvaluationCategory) && difficulties.has(raw.difficulty as string) && typeof raw.question === "string" && typeof raw.source === "string" && sources.has(raw.source)) {
        cases.push({ id, version: raw.version as number, category: raw.category as EvaluationCategory, difficulty: raw.difficulty as EvaluationCase["difficulty"], question: raw.question, expected: raw.expected as EvaluationExpectation, tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 16) : undefined, source: raw.source as EvaluationCase["source"], enabled: raw.enabled !== false });
      }
    });
  }
  if (issues.length > 0) throw new EvaluationDatasetError(issues);
  return { id: input.id as string, version: input.version as number, cases };
}
