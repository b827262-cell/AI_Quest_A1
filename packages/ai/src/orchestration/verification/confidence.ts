import type { VerificationEvidence } from "./verification-evidence";
import type { FusionOutcome, SafeVerificationDecision } from "../orchestration-diagnostics";

export interface AnswerConfidence {
  level: "high" | "medium" | "low" | "unverified";
  basis: "primary_only" | "model_verified" | "deterministic_verified" | "adjudicated" | "conflict_unresolved";
}

export function deriveAnswerConfidence(
  outcome: FusionOutcome,
  evidence: VerificationEvidence,
  verificationAttempted: boolean,
  verificationDecision?: SafeVerificationDecision
): AnswerConfidence {
  if (outcome === "primary_only") return { level: "unverified", basis: "primary_only" };
  if (outcome === "unresolved" || outcome === "conflict_detected") return { level: "low", basis: "conflict_unresolved" };
  if (outcome === "supplemented") return { level: "medium", basis: "model_verified" };
  if (outcome === "adjudicated") return {
    level: evidence.status === "passed" ? "high" : "medium",
    basis: "adjudicated"
  };
  if (outcome === "verified" && evidence.status === "passed" && verificationAttempted && verificationDecision === "agree") {
    return { level: "high", basis: "deterministic_verified" };
  }
  return { level: "medium", basis: "model_verified" };
}
