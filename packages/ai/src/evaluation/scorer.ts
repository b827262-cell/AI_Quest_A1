import type { EvaluationCase, EvaluationExpectation, EvaluationSubjectResult } from "./evaluation-types";
import type { EvaluationScore, EvaluationScorer } from "./scoring-types";
import { ClassificationScorer, ConceptScorer, ExactScorer, NumericScorer, ProgrammingScorer, SafetyScorer } from "./scorers";

const scorers: EvaluationScorer[] = [
  new ExactScorer(),
  new NumericScorer(),
  new ConceptScorer(),
  new ProgrammingScorer(),
  new ClassificationScorer(),
  new SafetyScorer()
];

export function scoreEvaluationCase(testCase: EvaluationCase, subject: EvaluationSubjectResult): EvaluationScore {
  const scorer = scorers.find((candidate) => candidate.supports(testCase.expected));
  if (!scorer) return { passed: false, score: 0, method: "safety", issues: [{ code: "unsupported_expectation", severity: "high", message: "no safe scorer supports this expectation" }] };
  return scorer.score(testCase, subject.answer, subject);
}

export function scoringMethodFor(expectation: EvaluationExpectation): EvaluationScore["method"] {
  const scorer = scorers.find((candidate) => candidate.supports(expectation));
  if (!scorer) throw new Error(`unsupported expectation kind: ${expectation.kind}`);
  return expectation.kind === "required_concepts" ? "heuristic_concepts" : expectation.kind === "programming_analysis" ? "programming_analysis" : expectation.kind;
}
