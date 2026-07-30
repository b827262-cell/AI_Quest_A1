import type {
  TokenPoolPort,
  LogicalModelMapping,
  ModelDailyLimitRow,
  TokenPoolRow
} from "@ai-smartbook/ai";
import type { Repositories } from "@ai-smartbook/db";

/**
 * Adapter that implements the TokenPoolPort against the repository bundle.
 *
 * The orchestration layer (in packages/ai) depends only on the abstract
 * TokenPoolPort, keeping packages/ai free of a hard @ai-smartbook/db dependency.
 * This adapter is the concrete binding the admin app supplies at gateway
 * construction time.
 */
export function createTokenPoolPort(repos: Repositories): TokenPoolPort {
  return {
    listEnabledLogicalModels(): LogicalModelMapping[] {
      return repos.aiLogicalModels.list().filter((row) => row.enabled);
    },

    findEnabledLogicalModel(logicalModelId: string): LogicalModelMapping | undefined {
      const row = repos.aiLogicalModels.findEnabled(logicalModelId);
      return row ?? undefined;
    },

    findModelDailyLimit(logicalModelId: string): ModelDailyLimitRow | undefined {
      return repos.aiModelDailyLimits.findByLogicalModel(logicalModelId);
    },

    findTokenPool(poolId: string): TokenPoolRow | undefined {
      return repos.aiTokenPools.findById(poolId);
    },

    reservePool(input) {
      return repos.aiTokenPoolReservations.reserve(input);
    },

    settlePool(reservationId: string, actualTokens: number) {
      repos.aiTokenPoolReservations.settle(reservationId, actualTokens);
    },

    releasePool(reservationId: string) {
      repos.aiTokenPoolReservations.release(reservationId);
    }
  };
}
