import type { EvaluationCase, EvaluationCaseResult, EvaluationExpectation, EvaluationIssue } from "./evaluation-types";

export interface EvaluationScore {
  passed: boolean;
  score: number;
  method: EvaluationCaseResult["scoringMethod"];
  issues: EvaluationIssue[];
}

export interface EvaluationScorer {
  supports(expectation: EvaluationExpectation): boolean;
  score(testCase: EvaluationCase, answer: string | undefined, subject?: EvaluationSubjectForScoring): EvaluationScore;
}

export interface EvaluationSubjectForScoring {
  classification?: string;
  outcome?: string;
  primaryAnswer?: string;
}
