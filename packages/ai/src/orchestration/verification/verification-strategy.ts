import type { TaskCategory } from "../classification/classification-types";
import type { DomainVerificationStrategy, VerificationEvidence, VerificationStrategyContext } from "./verification-evidence";
import { clampEvidenceConfidence } from "./verification-evidence";

export class GenericModelVerificationStrategy implements DomainVerificationStrategy {
  supports(category: TaskCategory): boolean {
    return category === "unknown";
  }

  async verify(_context: VerificationStrategyContext): Promise<VerificationEvidence> {
    return {
      strategy: "generic_model",
      status: "not_applicable",
      confidence: clampEvidenceConfidence(0),
      issues: [],
      safeSummary: "generic_model_verification",
      runtimeVerification: "unavailable"
    };
  }
}

export function unavailableEvidence(
  strategy: VerificationEvidence["strategy"],
  reason = "domain_verification_unavailable"
): VerificationEvidence {
  return {
    strategy,
    status: "unavailable",
    confidence: 0,
    issues: [],
    safeSummary: reason,
    runtimeVerification: "unavailable"
  };
}
