import type { EvaluationCase, EvaluationExpectation } from "../evaluation-types";
import type { EvaluationScore, EvaluationScorer, EvaluationSubjectForScoring } from "../scoring-types";

export class ClassificationScorer implements EvaluationScorer {
  supports(expectation: EvaluationExpectation): boolean { return expectation.kind === "classification"; }
  score(testCase: EvaluationCase, _answer: string | undefined, subject?: EvaluationSubjectForScoring): EvaluationScore {
    const expectation = testCase.expected;
    if (expectation.kind !== "classification") throw new Error("unsupported expectation");
    const passed = subject?.classification === expectation.expectedCategory;
    return { passed, score: passed ? 1 : 0, method: "classification", issues: passed ? [] : [{ code: "classification_mismatch", severity: "high", message: "classification did not match the expected category" }] };
  }
}
