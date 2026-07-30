import type { EvaluationCase, EvaluationExpectation } from "../evaluation-types";
import type { EvaluationScore } from "../scoring-types";

export class ExactScorer {
  supports(expectation: EvaluationExpectation): boolean { return expectation.kind === "exact"; }
  score(testCase: EvaluationCase, answer: string | undefined): EvaluationScore {
    const expectation = testCase.expected;
    if (expectation.kind !== "exact") throw new Error("unsupported expectation");
    const normalize = (value: string): string => expectation.normalizeWhitespace === false ? value : value.trim().replace(/\s+/g, " ");
    const actual = answer === undefined ? "" : normalize(answer);
    const accepted = expectation.acceptedAnswers.map((item) => normalize(item));
    const comparableActual = expectation.caseSensitive === false ? actual.toLocaleLowerCase() : actual;
    const comparableAccepted = expectation.caseSensitive === false ? accepted.map((item) => item.toLocaleLowerCase()) : accepted;
    const passed = comparableAccepted.includes(comparableActual);
    const issues = passed ? [] : [{ code: "exact_mismatch", severity: "high" as const, message: "answer did not match an accepted answer" }];
    return { passed, score: passed ? 1 : 0, method: "exact", issues };
  }
}
