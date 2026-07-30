/**
 * Ports (abstract interfaces) the orchestration layer needs from the host
 * application. Defining these in `packages/ai` keeps the orchestration logic
 * free of a hard dependency on `packages/db` — the admin app supplies a concrete
 * adapter backed by its repositories. This mirrors how `BudgetManager` and
 * `GatewayAiProvider` are abstract ports consumed by the gateway.
 *
 * The host adapter is responsible for any encryption, redaction, or audit
 * concerns; these ports only describe the data the orchestrator reads/writes.
 */

export interface LogicalModelMapping {
  logicalModelId: string;
  providerId: string;
  providerModelName: string;
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number;
  supportsThinking: boolean;
  tokenizerType: string | null;
  enabled: boolean;
  /** Community reports are display-only and cannot drive formal preflight. */
  capabilityEvidence?: "official_documentation" | "provider_runtime" | "admin_verified" | "community_report" | "unknown";
}

export interface ModelDailyLimitRow {
  logicalModelId: string;
  poolId: string;
  dailyLimit: number;
  usedTokens: number;
  reservedTokens: number;
  priority: number;
  fallbackLogicalModelId: string | null;
  enabled: boolean;
  allowSecondModelVerification: boolean;
  /** Optional explicit policy gate for conflict adjudication. */
  allowAdjudication?: boolean;
}

export interface TokenPoolRow {
  id: string;
  poolType: string;
  dailyLimit: number;
  usedTokens: number;
  reservedTokens: number;
  enabled: boolean;
}

export interface ReservePoolInput {
  reservationKey: string;
  requestId: string;
  attemptId: string;
  poolId: string;
  logicalModelId: string;
  estimatedTokens: number;
}

export interface ReservePoolResult {
  allowed: boolean;
  reservationId?: string;
  utilizationRatio: number;
  reason?: string;
  existingStatus?: "pending" | "settled" | "released";
}

/**
 * Port the TokenPoolBudgetManager and MultiModelOrchestrator depend on. The
 * admin app implements this against its repository bundle.
 */
export interface TokenPoolPort {
  // Logical model registry
  listEnabledLogicalModels(): LogicalModelMapping[];
  findEnabledLogicalModel(logicalModelId: string): LogicalModelMapping | undefined;

  // Model daily limits
  findModelDailyLimit(logicalModelId: string): ModelDailyLimitRow | undefined;

  // Token pools
  findTokenPool(poolId: string): TokenPoolRow | undefined;

  // Reservation ledger (concurrency-safe)
  reservePool(input: ReservePoolInput): ReservePoolResult;
  settlePool(reservationId: string, actualTokens: number): void;
  releasePool(reservationId: string): void;
}
