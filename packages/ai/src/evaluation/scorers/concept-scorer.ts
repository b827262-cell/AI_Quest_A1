import type { EvaluationCase, EvaluationExpectation, EvaluationIssue } from "../evaluation-types";
import type { EvaluationScore, EvaluationScorer, EvaluationSubjectForScoring } from "../scoring-types";

export class ConceptScorer implements EvaluationScorer {
  supports(expectation: EvaluationExpectation): boolean { return expectation.kind === "required_concepts"; }
  score(testCase: EvaluationCase, answer: string | undefined, _subject?: EvaluationSubjectForScoring): EvaluationScore {
    const expectation = testCase.expected;
    if (expectation.kind !== "required_concepts") throw new Error("unsupported expectation");
    const text = (answer ?? "").toLocaleLowerCase();
    const matched = [...new Set(expectation.required.filter((concept) => text.includes(concept.toLocaleLowerCase())))];
    const forbidden = (expectation.forbidden ?? []).filter((concept) => text.includes(concept.toLocaleLowerCase()));
    const minimum = expectation.minimumRequired ?? expectation.required.length;
    const score = matched.length / expectation.required.length;
    const passed = matched.length >= minimum && forbidden.length === 0;
    const issues: EvaluationIssue[] = [];
    if (matched.length < minimum) issues.push({ code: "required_concept_missing", severity: "high", message: "required concepts were incomplete" });
    if (forbidden.length > 0) issues.push({ code: "forbidden_concept", severity: "high", message: "answer contained a forbidden claim" });
    return { passed, score: forbidden.length > 0 ? 0 : score, method: "heuristic_concepts", issues: [{ code: "heuristic_scorer", severity: "low", message: "concept scoring is an offline heuristic" }, ...issues] };
  }
}
