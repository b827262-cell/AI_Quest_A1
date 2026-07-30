import type {
  BudgetCheckInput,
  BudgetCheckResult,
  BudgetManager,
  BudgetRecordInput,
  BudgetReservation
} from "../gateway/ai-gateway";
import type { CompositeBudgetReservation } from "./composite-reservation";
import { compositeFromInner, withPoolReservation } from "./composite-reservation";
import type { TokenPoolPort } from "./token-pool-ports";

/**
 * Token Pool Budget Manager (limit dimension 1: daily token pool).
 *
 * A DECORATOR around the inner (global/source) BudgetManager. It adds the
 * Token Pool + per-model daily-limit check as an ADDITIONAL gate, enforced
 * AFTER the inner reservation succeeds. It NEVER modifies the gateway control
 * flow — the gateway already calls `reserve()/settleReservation()/
 * releaseReservation()`, and this manager slots in transparently.
 *
 * Compensation flow (spec §6):
 *   1. inner.reserve()  → if denied, return the inner denial.
 *   2. Look up the logical model; if unmapped or has no model-limit config,
 *      pass through (non-OpenAI / unconfigured providers are unaffected).
 *   3. tokenPool.reserve()  → if the pool denies, RELEASE the inner reservation
 *      (failure compensation) and return a pool-exhausted denial.
 *   4. Both succeed → return a CompositeBudgetReservation.
 *
 * Utilization is returned as a 0..1 ratio; thresholds are stored as integer
 * percentages (0-100) in the DB and divided by 100 on read.
 */
export class TokenPoolBudgetManager implements BudgetManager {
  constructor(
    private readonly inner: BudgetManager,
    private readonly pool: TokenPoolPort
  ) {}

  async preCheck(input: BudgetCheckInput): Promise<BudgetCheckResult> {
    // Delegate to the inner manager; the pool's authoritative check happens in reserve().
    return this.inner.preCheck(input);
  }

  async reserve(input: BudgetCheckInput): Promise<BudgetCheckResult> {
    // --- Step 1: inner (global/source) reservation. ---
    const innerPresent = typeof this.inner.reserve === "function";
    const innerResult: BudgetCheckResult = innerPresent
      ? await this.inner.reserve!(input)
      : await this.inner.preCheck(input);
    if (!innerResult.allowed) {
      return innerResult;
    }

    // --- Step 2: resolve logical model mapping for the requested model. ---
    // The gateway passes the real provider model name in input.model. Map it
    // back to a logical model id to find the pool/model-limit config.
    const logicalModel = this.findLogicalModelByProviderModel(input.provider, input.model);
    if (!logicalModel) {
      // No logical-model mapping for this provider+model → pool does not apply.
      // Pass through with the inner reservation (non-OpenAI / unconfigured models).
      return innerResult;
    }
    const modelLimit = this.pool.findModelDailyLimit(logicalModel.logicalModelId);
    if (!modelLimit) {
      // Logical model exists but has no daily-limit row → pool does not apply.
      return innerResult;
    }

    // --- Step 3: Token Pool reservation. ---
    const requestId = input.requestId ?? "unknown-request";
    const attemptId = `${requestId}:${logicalModel.logicalModelId}`;
    const reservationKey = `${requestId}:${attemptId}:${modelLimit.poolId}:${logicalModel.logicalModelId}`;
    const estimatedTokens = input.inputTokens + input.estimatedOutputTokens;
    const poolResult = this.pool.reservePool({
      reservationKey,
      requestId,
      attemptId,
      poolId: modelLimit.poolId,
      logicalModelId: logicalModel.logicalModelId,
      estimatedTokens
    });

    if (!poolResult.allowed) {
      // --- Failure compensation: release the inner reservation we just made. ---
      if (innerResult.reservation && typeof this.inner.releaseReservation === "function") {
        await this.inner.releaseReservation(innerResult.reservation).catch(() => undefined);
      }
      const reason =
        poolResult.reason === "model_daily_limit_exhausted"
          ? "model_daily_limit_exhausted"
          : "token_pool_exhausted";
      return {
        allowed: false,
        utilisation: poolResult.utilizationRatio,
        reason
      };
    }

    // --- Step 4: build the composite reservation. ---
    const innerReservation: BudgetReservation = innerResult.reservation ?? {
      id: `${requestId}:inner`,
      provider: input.provider,
      model: input.model,
      estimatedTokens,
      estimatedCostMicroUsd: input.estimatedCostMicroUsd
    };
    const base = compositeFromInner(innerReservation, attemptId);
    const composite: CompositeBudgetReservation = withPoolReservation(base, {
      poolReservationId: poolResult.reservationId!,
      poolId: modelLimit.poolId,
      logicalModelId: logicalModel.logicalModelId,
      reservationKey
    });

    return {
      allowed: true,
      utilisation: poolResult.utilizationRatio,
      reservation: composite
    };
  }

  async settleReservation(reservation: BudgetReservation, input: BudgetRecordInput): Promise<void> {
    // --- Inner settle first. ---
    const composite = reservation as CompositeBudgetReservation;
    const innerReservation = composite.innerReservation ?? reservation;
    if (typeof this.inner.settleReservation === "function") {
      await this.inner.settleReservation(innerReservation, input);
    }
    // --- Pool settle (idempotent). ---
    if (composite.poolReservationId) {
      const actualTokens = input.totalTokens > 0 ? input.totalTokens : input.inputTokens + input.outputTokens;
      this.pool.settlePool(composite.poolReservationId, actualTokens);
    }
  }

  async releaseReservation(reservation: BudgetReservation): Promise<void> {
    const composite = reservation as CompositeBudgetReservation;
    // --- Inner release. ---
    const innerReservation = composite.innerReservation ?? reservation;
    if (typeof this.inner.releaseReservation === "function") {
      await this.inner.releaseReservation(innerReservation).catch(() => undefined);
    }
    // --- Pool release (idempotent). ---
    if (composite.poolReservationId) {
      this.pool.releasePool(composite.poolReservationId);
    }
  }

  async recordUsage(input: BudgetRecordInput): Promise<void> {
    // Pool usage is recorded via settleReservation, not recordUsage.
    await this.inner.recordUsage(input);
  }

  /**
   * Find the enabled logical model whose providerId + providerModelName match
   * the request. Returns undefined when there is no mapping (passthrough).
   */
  private findLogicalModelByProviderModel(provider: string, providerModelName: string) {
    return this.pool
      .listEnabledLogicalModels()
      .find(
        (row) =>
          row.providerId === provider &&
          row.providerModelName.toLocaleLowerCase() === providerModelName.trim().toLocaleLowerCase()
      );
  }
}
