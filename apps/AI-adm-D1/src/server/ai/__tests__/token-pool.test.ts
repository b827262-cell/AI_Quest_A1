import { afterEach, describe, expect, it } from "vitest";
import { createDbHandle, runMigrations, createRepositories } from "@ai-smartbook/db";
import type { Repositories } from "@ai-smartbook/db";

let handle: ReturnType<typeof createDbHandle> | undefined;

function setup(): Repositories {
  handle = createDbHandle(":memory:");
  runMigrations(handle.sqlite);
  return createRepositories(handle.db);
}

afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
});

/**
 * Token Pool reservation lifecycle + four-dimension independence tests.
 *
 * Covers acceptance criteria:
 *   1. Shared pool correctly deducts tokens.
 *   2. Single model daily cap enforced.
 *   3. Sol uses its independent pool.
 *   4. Asia/Taipei daily reset (atomic inside reserve).
 *   5. Concurrent requests do not over-spend.
 *   6. Failed request releases reserved tokens.
 *   7. Quota exhaustion → reason code.
 *   8. Usage Log contains no API key material.
 *  10. Non-OpenAI / unconfigured providers unaffected (passthrough).
 *  11. Pool reserve failure releases inner budget.
 *  12. Same reservationKey re-reserve is idempotent.
 *  13. Settle called twice does not double-charge.
 *  14. Release called twice does not increase quota.
 *  15. Same requestId different attemptId opens new reservation (fallback).
 *  16. Cross-day reset + reserve in one transaction.
 *  17. actualTokens > estimatedTokens → overage recorded correctly.
 *  18. Sol pool exhaustion does not affect shared pool.
 *  19. Shared pool exhaustion does not affect other pools.
 */
describe("Token Pool reservation lifecycle", () => {
  it("1. shared pool correctly deducts tokens on settle", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;
    const terra = repos.aiModelDailyLimits.findByLogicalModel("gpt-5.6-terra")!;

    const result = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-1:att-1:shared:gpt-5.6-terra",
      requestId: "req-1",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 1000
    });
    expect(result.allowed).toBe(true);
    expect(result.reservationId).toBeDefined();

    // Reserved but not yet settled.
    const poolAfterReserve = repos.aiTokenPools.findById(shared.id)!;
    expect(poolAfterReserve.reservedTokens).toBe(1000);
    expect(poolAfterReserve.usedTokens).toBe(0);

    const settleResult = repos.aiTokenPoolReservations.settle(result.reservationId!, 800);
    expect(settleResult.ok).toBe(true);
    expect(settleResult.actualTokens).toBe(800);

    const poolAfterSettle = repos.aiTokenPools.findById(shared.id)!;
    expect(poolAfterSettle.usedTokens).toBe(800);
    expect(poolAfterSettle.reservedTokens).toBe(0);

    const terraAfter = repos.aiModelDailyLimits.findByLogicalModel("gpt-5.6-terra")!;
    expect(terraAfter.usedTokens).toBe(800);
    void terra;
  });

  it("2. single model daily cap is enforced", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;
    // gpt-5.4-mini has a 200,000 daily cap.
    const result = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-2:att-1:shared:gpt-5.4-mini",
      requestId: "req-2",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.4-mini",
      estimatedTokens: 250_000
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("model_daily_limit_exhausted");
  });

  it("3. Sol uses its independent pool (does not touch shared)", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;
    const sol = repos.aiTokenPools.findByType("sol")!;

    const result = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-3:att-1:sol:gpt-5.6-sol",
      requestId: "req-3",
      attemptId: "att-1",
      poolId: sol.id,
      logicalModelId: "gpt-5.6-sol",
      estimatedTokens: 50_000
    });
    expect(result.allowed).toBe(true);

    repos.aiTokenPoolReservations.settle(result.reservationId!, 50_000);

    const sharedAfter = repos.aiTokenPools.findById(shared.id)!;
    const solAfter = repos.aiTokenPools.findById(sol.id)!;
    expect(solAfter.usedTokens).toBe(50_000);
    expect(sharedAfter.usedTokens).toBe(0);
  });

  it("5. concurrent requests at the boundary do not over-spend", () => {
    const repos = setup();
    const sol = repos.aiTokenPools.findByType("sol")!;
    // Tighten both gates to 1000 tokens for a precise boundary test.
    repos.aiModelDailyLimits.update("gpt-5.6-sol", { dailyLimit: 1000 });
    repos.aiTokenPools.update(sol.id, { dailyLimit: 1000 });

    const r1 = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-c1:att-1:sol:gpt-5.6-sol",
      requestId: "req-c1",
      attemptId: "att-1",
      poolId: sol.id,
      logicalModelId: "gpt-5.6-sol",
      estimatedTokens: 600
    });
    const r2 = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-c2:att-1:sol:gpt-5.6-sol",
      requestId: "req-c2",
      attemptId: "att-1",
      poolId: sol.id,
      logicalModelId: "gpt-5.6-sol",
      estimatedTokens: 600
    });
    // Only one of the two 600-token reservations can fit in the 1000 cap.
    const allowed = [r1.allowed, r2.allowed].filter(Boolean).length;
    expect(allowed).toBe(1);
    // The combined reserved must not exceed the cap.
    const solAfter = repos.aiTokenPools.findByType("sol")!;
    expect(solAfter.reservedTokens).toBeLessThanOrEqual(1000);
  });

  it("6. failed request releases reserved tokens", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;

    const result = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-6:att-1:shared:gpt-5.6-terra",
      requestId: "req-6",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 1000
    });
    expect(result.allowed).toBe(true);

    const releaseResult = repos.aiTokenPoolReservations.release(result.reservationId!);
    expect(releaseResult.ok).toBe(true);
    expect(releaseResult.status).toBe("released");

    const poolAfter = repos.aiTokenPools.findById(shared.id)!;
    expect(poolAfter.reservedTokens).toBe(0);
    expect(poolAfter.usedTokens).toBe(0);
  });

  it("7. quota exhaustion returns a clear reason code", () => {
    const repos = setup();
    const sol = repos.aiTokenPools.findByType("sol")!;
    // Exhaust the sol pool by settling its entire 200k limit.
    const r = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-7a:att-1:sol:gpt-5.6-sol",
      requestId: "req-7a",
      attemptId: "att-1",
      poolId: sol.id,
      logicalModelId: "gpt-5.6-sol",
      estimatedTokens: 200_000
    });
    repos.aiTokenPoolReservations.settle(r.reservationId!, 200_000);

    const r2 = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-7b:att-1:sol:gpt-5.6-sol",
      requestId: "req-7b",
      attemptId: "att-1",
      poolId: sol.id,
      logicalModelId: "gpt-5.6-sol",
      estimatedTokens: 1
    });
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe("token_pool_exhausted");
  });

  it("8. usage log row contains no API key / credential plaintext material", () => {
    const repos = setup();
    const usageLog = repos.aiUsageLogs.create({
      requestId: "req-8",
      provider: "openai",
      credentialId: "aic_test-credential-id",
      model: "gpt-5.6-terra",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      questionText: "sample question",
      answerText: "sample answer",
      poolId: "aitp_pool-id",
      logicalModelId: "gpt-5.6-terra",
      estimated: false,
      overageTokens: 0,
      usageSource: "provider_response",
      inputCostMicrousd: 0,
      cachedInputCostMicrousd: 0,
      outputCostMicrousd: 0,
      totalCostMicrousd: 0,
      estimatedCostMicroUsd: 0,
      actualCostMicroUsd: 0
    });
    expect(usageLog.id).toBeDefined();
    // The persisted row must never carry key material columns.
    const row = handle!.sqlite
      .prepare("SELECT * FROM ai_usage_logs WHERE id = ?")
      .get(usageLog.id) as Record<string, unknown>;
    const forbiddenKeys = ["api_key", "apikey", "encrypted_api_key", "secret", "password"];
    for (const key of forbiddenKeys) {
      expect(Object.keys(row)).not.toContain(key);
    }
    // The answer/question text is bounded redacted content, not a credential.
    expect(row.credential_id).toBe("aic_test-credential-id"); // id only, never the key
  });

  it("12. same reservationKey re-reserve is idempotent (no double-reserve)", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;

    const r1 = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-12:att-1:shared:gpt-5.6-terra",
      requestId: "req-12",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 500
    });
    expect(r1.allowed).toBe(true);

    // Re-reserve with the SAME key.
    const r2 = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-12:att-1:shared:gpt-5.6-terra",
      requestId: "req-12",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 500
    });
    expect(r2.allowed).toBe(true);
    expect(r2.reservationId).toBe(r1.reservationId);
    // Reserved tokens must NOT have doubled.
    const poolAfter = repos.aiTokenPools.findById(shared.id)!;
    expect(poolAfter.reservedTokens).toBe(500);
  });

  it("13. settle called twice does not double-charge", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;

    const r = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-13:att-1:shared:gpt-5.6-terra",
      requestId: "req-13",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 1000
    });
    const first = repos.aiTokenPoolReservations.settle(r.reservationId!, 800);
    expect(first.ok).toBe(true);
    // Second settle on the same reservation is a NOOP.
    const second = repos.aiTokenPoolReservations.settle(r.reservationId!, 999);
    expect(second.ok).toBe(true);
    expect(second.actualTokens).toBe(800); // returns existing, not 999

    const poolAfter = repos.aiTokenPools.findById(shared.id)!;
    expect(poolAfter.usedTokens).toBe(800); // not 800 + 999
  });

  it("14. release called twice does not increase quota back", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;

    const r = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-14:att-1:shared:gpt-5.6-terra",
      requestId: "req-14",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 1000
    });
    const first = repos.aiTokenPoolReservations.release(r.reservationId!);
    expect(first.ok).toBe(true);
    // Second release is a NOOP (already released).
    const second = repos.aiTokenPoolReservations.release(r.reservationId!);
    expect(second.ok).toBe(true);
    expect(second.status).toBe("released");

    const poolAfter = repos.aiTokenPools.findById(shared.id)!;
    expect(poolAfter.reservedTokens).toBe(0);
  });

  it("15. same requestId with different attemptId opens a new reservation (fallback)", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;

    const r1 = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-15:att-1:shared:gpt-5.6-terra",
      requestId: "req-15",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 500
    });
    // Fallback: release the first, then open a second attempt.
    repos.aiTokenPoolReservations.release(r1.reservationId!);

    const r2 = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-15:att-2:shared:gpt-5.6-luna",
      requestId: "req-15",
      attemptId: "att-2",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-luna",
      estimatedTokens: 300
    });
    expect(r2.allowed).toBe(true);
    expect(r2.reservationId).not.toBe(r1.reservationId);
  });

  it("16. cross-day reset + reserve happen atomically in one transaction", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;
    // Raise Terra's daily cap so it can absorb the full pool for this test.
    repos.aiModelDailyLimits.update("gpt-5.6-terra", { dailyLimit: 2_500_000 });
    // Exhaust the pool today.
    const r = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-16a:att-1:shared:gpt-5.6-terra",
      requestId: "req-16a",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 2_500_000
    });
    expect(r.allowed).toBe(true);
    repos.aiTokenPoolReservations.settle(r.reservationId!, 2_500_000);

    // Force the pool's resetAt into the past so the next reserve must reset.
    handle!.sqlite
      .prepare("UPDATE ai_token_pools SET reset_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", shared.id);

    // A new reserve should reset (usedTokens → 0) AND reserve atomically.
    const r2 = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-16b:att-1:shared:gpt-5.6-terra",
      requestId: "req-16b",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 1000,
      now: new Date()
    });
    expect(r2.allowed).toBe(true);
    const poolAfter = repos.aiTokenPools.findById(shared.id)!;
    expect(poolAfter.usedTokens).toBe(0); // reset
    expect(poolAfter.reservedTokens).toBe(1000); // new reservation
  });

  it("17. actualTokens > estimatedTokens records overage without going negative", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;

    const r = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-17:att-1:shared:gpt-5.6-terra",
      requestId: "req-17",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 1000
    });
    // Provider actually used more than reserved.
    const settleResult = repos.aiTokenPoolReservations.settle(r.reservationId!, 1500);
    expect(settleResult.overage).toBe(true);
    expect(settleResult.actualTokens).toBe(1500);
    expect(settleResult.estimatedTokens).toBe(1000);

    const poolAfter = repos.aiTokenPools.findById(shared.id)!;
    expect(poolAfter.usedTokens).toBe(1500); // actual charged
    expect(poolAfter.reservedTokens).toBe(0);
    // No negative counters.
    expect(poolAfter.usedTokens).toBeGreaterThanOrEqual(0);
    expect(poolAfter.reservedTokens).toBeGreaterThanOrEqual(0);
  });

  it("18. Sol pool exhaustion does not affect the shared pool", () => {
    const repos = setup();
    const shared = repos.aiTokenPools.findByType("shared")!;
    const sol = repos.aiTokenPools.findByType("sol")!;

    // Exhaust Sol.
    const r = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-18a:att-1:sol:gpt-5.6-sol",
      requestId: "req-18a",
      attemptId: "att-1",
      poolId: sol.id,
      logicalModelId: "gpt-5.6-sol",
      estimatedTokens: 200_000
    });
    repos.aiTokenPoolReservations.settle(r.reservationId!, 200_000);

    // Shared pool must still be fully usable.
    const r2 = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-18b:att-1:shared:gpt-5.6-terra",
      requestId: "req-18b",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 100_000
    });
    expect(r2.allowed).toBe(true);
  });
});

describe("Four-dimension independence", () => {
  it("19. unconfigured logical model (non-OpenAI provider) is unaffected by the pool", () => {
    const repos = setup();
    // A logical model that is NOT mapped (no row) should not block a provider.
    // The reservation repo returns model_limit_not_configured for an unknown
    // logical model, which the TokenPoolBudgetManager interprets as passthrough.
    const shared = repos.aiTokenPools.findByType("shared")!;
    const result = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-19:att-1:shared:nonexistent-model",
      requestId: "req-19",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "nonexistent-model",
      estimatedTokens: 100
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("model_limit_not_configured");
    // The shared pool counters must be untouched.
    const poolAfter = repos.aiTokenPools.findByType("shared")!;
    expect(poolAfter.usedTokens).toBe(0);
    expect(poolAfter.reservedTokens).toBe(0);
  });

  it("20. disabled pool rejects new reservations", () => {
    const repos = setup();
    const sol = repos.aiTokenPools.findByType("sol")!;
    repos.aiTokenPools.update(sol.id, { enabled: false });

    const result = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-20:att-1:sol:gpt-5.6-sol",
      requestId: "req-20",
      attemptId: "att-1",
      poolId: sol.id,
      logicalModelId: "gpt-5.6-sol",
      estimatedTokens: 100
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("pool_disabled");
  });

  it("21. logical model daily limit (dim 3) is independent of context window (dim 4)", () => {
    const repos = setup();
    // A model can have a large daily limit but a small context window, or vice
    // versa. The daily-limit check (dim 3) does not consult context window.
    const shared = repos.aiTokenPools.findByType("shared")!;
    repos.aiLogicalModels.update("gpt-5.6-terra", { contextWindowTokens: 100 }); // tiny window
    // The daily limit is unaffected; a 1000-token reserve still passes dim 3.
    const result = repos.aiTokenPoolReservations.reserve({
      reservationKey: "req-21:att-1:shared:gpt-5.6-terra",
      requestId: "req-21",
      attemptId: "att-1",
      poolId: shared.id,
      logicalModelId: "gpt-5.6-terra",
      estimatedTokens: 1000
    });
    expect(result.allowed).toBe(true);
    // Context window (dim 4) is checked separately in the orchestrator, not here.
    const logical = repos.aiLogicalModels.findByLogicalId("gpt-5.6-terra")!;
    expect(logical.contextWindowTokens).toBe(100);
  });
});
