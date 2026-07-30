/** Stable, secret-free outcomes produced by the fusion layer. */
export type FusionOutcome =
  | "primary_only"
  | "verified"
  | "supplemented"
  | "conflict_detected"
  | "adjudicated"
  | "unresolved";

export type SafeVerificationDecision = "agree" | "supplement" | "conflict" | "uncertain";

export type OrchestrationFallbackReason =
  | "classification_unavailable"
  | "domain_verification_unavailable"
  | "domain_evidence_conflict"
  | "second_model_ineligible"
  | "verification_throttled"
  | "verification_unavailable"
  | "verification_quota_exhausted"
  | "verification_context_window"
  | "verification_parse_failed"
  | "verification_uncertain"
  | "adjudication_disabled"
  | "adjudication_unconfigured"
  | "adjudication_throttled"
  | "adjudication_quota_exhausted"
  | "adjudication_context_window"
  | "adjudication_unavailable"
  | "adjudication_parse_failed"
  | "adjudication_insufficient_information";

/** Diagnostics intentionally contain only allowlisted metadata. */
export interface MultiModelFusionDiagnostics {
  outcome: FusionOutcome;
  verificationAttempted: boolean;
  verificationModel?: string;
  verificationDecision?: SafeVerificationDecision;
  /** Config-owned Router explanation, bounded and stripped of control text. */
  secondModelReason?: string;
  adjudicationAttempted: boolean;
  adjudicationModel?: string;
  conflictDetected: boolean;
  modelCallCount: number;
  fallbackReason?: OrchestrationFallbackReason;
  taskCategory?: "programming" | "mathematics" | "knowledge" | "unknown";
  classificationSource?: "deterministic" | "model" | "fallback";
  verificationStrategy?:
    | "programming_static"
    | "programming_runtime"
    | "mathematical_numeric"
    | "mathematical_structured"
    | "knowledge_consistency"
    | "generic_model"
    | "none";
  evidenceStatus?: "passed" | "failed" | "partial" | "not_applicable" | "unavailable";
  confidenceLevel?: "high" | "medium" | "low" | "unverified";
  confidenceBasis?: "primary_only" | "model_verified" | "deterministic_verified" | "adjudicated" | "conflict_unresolved";
}

export interface DomainVerificationDiagnostics {
  taskCategory: NonNullable<MultiModelFusionDiagnostics["taskCategory"]>;
  classificationSource: NonNullable<MultiModelFusionDiagnostics["classificationSource"]>;
  verificationStrategy: NonNullable<MultiModelFusionDiagnostics["verificationStrategy"]>;
  evidenceStatus: NonNullable<MultiModelFusionDiagnostics["evidenceStatus"]>;
  confidenceLevel: NonNullable<MultiModelFusionDiagnostics["confidenceLevel"]>;
}
