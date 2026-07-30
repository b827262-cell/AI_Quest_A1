import type { EvaluationCase, EvaluationExpectation, EvaluationIssue } from "../evaluation-types";
import type { EvaluationScore, EvaluationScorer, EvaluationSubjectForScoring } from "../scoring-types";

export class ProgrammingScorer implements EvaluationScorer {
  supports(expectation: EvaluationExpectation): boolean { return expectation.kind === "programming_analysis"; }
  score(testCase: EvaluationCase, answer: string | undefined, _subject?: EvaluationSubjectForScoring): EvaluationScore {
    const expectation = testCase.expected;
    if (expectation.kind !== "programming_analysis") throw new Error("unsupported expectation");
    const text = (answer ?? "").toLocaleLowerCase();
    const findings = expectation.requiredFindings.filter((finding) => text.includes(finding.toLocaleLowerCase()));
    const forbidden = (expectation.forbiddenClaims ?? []).filter((claim) => text.includes(claim.toLocaleLowerCase()));
    const flags: Array<[boolean | undefined, string, string]> = [
      [expectation.requiresUndefinedBehaviorNotice, "undefined_behavior_notice_missing", "undefined behavior notice was missing"],
      [expectation.requiresCompileErrorNotice, "compile_error_notice_missing", "compile error notice was missing"],
      [expectation.requiresRuntimeWarning, "runtime_warning_missing", "runtime warning was missing"]
    ];
    const issues: EvaluationIssue[] = [{ code: "heuristic_scorer", severity: "low", message: "programming analysis scoring is rule-based and does not execute code" }];
    for (const [required, code, message] of flags) {
      const phrase = code.replace(/_(?:notice|warning)_missing$/, "").replaceAll("_", " ");
      if (required && !text.includes(phrase)) issues.push({ code, severity: "high", message });
    }
    if (findings.length !== expectation.requiredFindings.length) issues.push({ code: "required_finding_missing", severity: "high", message: "required programming findings were incomplete" });
    if (forbidden.length > 0) issues.push({ code: "forbidden_programming_claim", severity: "high", message: "answer contained a forbidden programming claim" });
    const passed = findings.length === expectation.requiredFindings.length && forbidden.length === 0 && !issues.some((issue) => issue.severity === "high");
    return { passed, score: forbidden.length > 0 ? 0 : findings.length / expectation.requiredFindings.length, method: "programming_analysis", issues };
  }
}
