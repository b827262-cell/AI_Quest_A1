/** Explicit browser-safe entry. It contains no Node built-ins or secrets. */
export * from "./gateway/pricing";
export type { AiProviderId } from "./gateway/ai-types";
export * from "./rag";

// Pure feature-gate helpers only; no filesystem, provider or credential access.
export {
  assignPilot,
  buildLiveEvaluationReadiness,
  evaluatePilotAutoStop,
  evaluateProductionReadiness,
  validatePilotSettings,
  validatePilotStopPolicy,
  DEFAULT_MULTI_MODEL_PILOT_SETTINGS
} from "./evaluation/readiness-pilot";
export type {
  LiveEvaluationReadiness,
  MultiModelPilotSettings,
  PilotStopPolicy,
  PilotTaskCategory,
  ProductionReadinessCheck,
  ProductionReadinessInputs,
  ProductionReadinessResult
} from "./evaluation/readiness-pilot";
