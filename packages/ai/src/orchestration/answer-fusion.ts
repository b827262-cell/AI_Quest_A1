import type { VerificationResult } from "./verification-result";
import type { FusionOutcome, OrchestrationFallbackReason } from "./orchestration-diagnostics";

export interface AnswerFusionResult {
  outcome: FusionOutcome;
  finalAnswer: string;
  conflictDetected: boolean;
  fallbackReason?: OrchestrationFallbackReason;
}

function comparable(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isDuplicate(primary: string, supplement: string): boolean {
  const primaryNormalized = comparable(primary);
  const supplementNormalized = comparable(supplement);
  return (
    supplementNormalized.length === 0 ||
    primaryNormalized === supplementNormalized ||
    primaryNormalized.includes(supplementNormalized)
  );
}

/** Deterministic fusion; verification proposedAnswer is intentionally ignored. */
export function fusePrimaryAndVerification(
  primaryAnswer: string,
  verification: VerificationResult
): AnswerFusionResult {
  if (verification.decision === "agree") {
    return { outcome: "verified", finalAnswer: primaryAnswer, conflictDetected: false };
  }

  if (verification.decision === "supplement") {
    const supplementWouldAlterCore = verification.issues.some(
      (issue) =>
        issue.severity === "high" &&
        ["factual", "calculation", "logic", "code", "safety"].includes(issue.category)
    );
    if (supplementWouldAlterCore) {
      return {
        outcome: "conflict_detected",
        finalAnswer: primaryAnswer,
        conflictDetected: true
      };
    }
    const supplement = verification.supplementalContent?.trim() ?? "";
    if (isDuplicate(primaryAnswer, supplement)) {
      return { outcome: "supplemented", finalAnswer: primaryAnswer, conflictDetected: false };
    }
    return {
      outcome: "supplemented",
      finalAnswer: `${primaryAnswer}\n\n補充說明：\n${supplement}`,
      conflictDetected: false
    };
  }

  if (verification.decision === "conflict") {
    return {
      outcome: "conflict_detected",
      finalAnswer: primaryAnswer,
      conflictDetected: true
    };
  }

  return {
    outcome: "unresolved",
    finalAnswer: primaryAnswer,
    conflictDetected: false,
    fallbackReason: "verification_uncertain"
  };
}
