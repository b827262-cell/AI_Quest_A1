import type { EvaluationCase, EvaluationExpectation, EvaluationIssue } from "../evaluation-types";
import type { EvaluationScore, EvaluationScorer, EvaluationSubjectForScoring } from "../scoring-types";

/**
 * Extract the final numeric value from an answer. A worked solution typically
 * states operands first and the final answer last (e.g. "2 + 3 = 5"), so we
 * take the LAST finite match — not the first. This mirrors
 * MathematicsVerifier.extractAnswerNumber so the scorer and the deterministic
 * verifier agree on which number represents the answer.
 *
 * Supports decimals (incl. leading-dot), scientific notation, thousands
 * separators (commas) and a percent sign immediately trailing a number
 * (divided by 100). Returns undefined when no finite number is present, which
 * yields numeric_answer_missing upstream.
 */
function extractNumber(answer: string | undefined): number | undefined {
  if (!answer) return undefined;
  const matches = [...answer.replace(/,/g, "").matchAll(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?%?/g)];
  const raw = matches.at(-1)?.[0];
  if (!raw) return undefined;
  const percent = raw.endsWith("%");
  const value = Number(percent ? raw.slice(0, -1) : raw);
  return Number.isFinite(value) ? (percent ? value / 100 : value) : undefined;
}

export class NumericScorer implements EvaluationScorer {
  supports(expectation: EvaluationExpectation): boolean { return expectation.kind === "numeric"; }
  score(testCase: EvaluationCase, answer: string | undefined, _subject?: EvaluationSubjectForScoring): EvaluationScore {
    const expectation = testCase.expected;
    if (expectation.kind !== "numeric") throw new Error("unsupported expectation");
    const value = extractNumber(answer);
    const unitOk = expectation.unit === undefined || (answer ?? "").toLocaleLowerCase().includes(expectation.unit.toLocaleLowerCase());
    const passed = value !== undefined && unitOk && Math.abs(value - expectation.expectedValue) <= expectation.tolerance;
    const issues: EvaluationIssue[] = [];
    if (value === undefined) issues.push({ code: "numeric_answer_missing", severity: "high", message: "no finite numeric answer was found" });
    else if (!unitOk) issues.push({ code: "numeric_unit_mismatch", severity: "high", message: "answer unit did not match the expected unit" });
    else if (!passed) issues.push({ code: "numeric_out_of_tolerance", severity: "high", message: "numeric answer was outside the configured tolerance" });
    return { passed, score: passed ? 1 : 0, method: "numeric", issues };
  }
}
