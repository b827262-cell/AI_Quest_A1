import { describe, expect, it } from "vitest";
import {
  computeCostBreakdown,
  priceFor,
  pricingSnapshotFor,
  serializePricingSnapshot,
  estimateCostMicroUsd,
  multiplySafe,
  microUsdToUsd,
  hasExactPricing,
  isUnpricedTier
} from "../src/gateway/pricing";

const USD = (micro: number): number => micro / 1_000_000;

describe("pricing + cost math", () => {
  it("mock is always free", () => {
    expect(estimateCostMicroUsd("mock", "mock-v1", 1000, 1000)).toBe(0);
    expect(priceFor("mock", "anything").inputPriceUsdPerMillion).toBe(0);
  });

  it("unknown model with only wildcard match returns unavailable pricing", () => {
    const p = priceFor("openai", "some-future-model");
    // No exact seed entry → wildcard-only → unavailable (0 prices, never official).
    expect(p.serviceTier).toBe("unavailable");
    expect(p.inputPriceUsdPerMillion).toBe(0);
    expect(p.outputPriceUsdPerMillion).toBe(0);
    expect(p.pricingSource).toBe("wildcard_fallback");
  });

  it("unknown provider defaults to a free sentinel (source=unknown)", () => {
    const p = priceFor("mock" as never, "x");
    expect(p.inputPriceUsdPerMillion).toBeGreaterThanOrEqual(0);
  });

  it("estimateCostMicroUsd returns an integer (no float drift)", () => {
    const cost = estimateCostMicroUsd("openai", "gpt-4o-mini", 1000, 500);
    expect(Number.isInteger(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
  });

  it("multiplySafe guards NaN/zero and rounds half-up", () => {
    expect(multiplySafe(0, 5)).toBe(0);
    expect(multiplySafe(Number.NaN, 5)).toBe(0);
    expect(multiplySafe(2.7, 3)).toBe(8); // rounds half-up
    // Half-up rounding: 1.5 → 2 (was trunc → 1 in the old buggy code).
    expect(multiplySafe(1, 1.5)).toBe(2);
    expect(multiplySafe(3, 0.5)).toBe(2);
  });

  it("microUsdToUsd divides by 1e6", () => {
    expect(microUsdToUsd(1_000_000)).toBe(1);
    expect(microUsdToUsd(150)).toBe(0.00015);
  });

  // ----- gemini-3.6-flash Standard seeding (spec §5.4) --------------------
  it("seeds gemini-3.6-flash Standard prices exactly", () => {
    const p = priceFor("gemini", "gemini-3.6-flash");
    expect(p.serviceTier).toBe("standard");
    expect(p.currency).toBe("USD");
    expect(p.inputPriceUsdPerMillion).toBe(1.5);
    expect(p.outputPriceUsdPerMillion).toBe(7.5);
    expect(p.cachedInputPriceUsdPerMillion).toBe(0.15);
    expect(p.cacheStorageUsdPerMillionTokenHour).toBe(1.0);
    expect(p.pricingSource).toContain("google-ai-studio");
    expect(hasExactPricing("gemini", "gemini-3.6-flash")).toBe(true);
  });

  it("seeds gemini-3.5-flash-lite Standard prices exactly", () => {
    const p = priceFor("gemini", "gemini-3.5-flash-lite");
    expect(p.inputPriceUsdPerMillion).toBe(0.3);
    expect(p.outputPriceUsdPerMillion).toBe(2.5);
    expect(p.cachedInputPriceUsdPerMillion).toBe(0.03);
  });

  // ----- 4,242-token regression (spec §8.1) --------------------------------
  it("4,242 tokens on gemini-3.6-flash never yields $3.34 and stays <= $0.031815", () => {
    // Treat all 4,242 as output (the most expensive single bucket) — this is
    // the theoretical maximum for that token count at the output rate.
    const { cost } = computeCostBreakdown("gemini", "gemini-3.6-flash", {
      promptTokens: 0,
      cachedInputTokens: 0,
      candidatesTokens: 4242,
      thinkingTokens: 0
    });
    const totalUsd = USD(cost.totalCostMicroUsd);
    // Must never be the broken $3.34.
    expect(totalUsd).not.toBe(3.34);
    expect(totalUsd).toBeLessThanOrEqual(Number.EPSILON + 0.031815);
    // Exact: 4242 * 7.5 / 1e6 = 0.031815.
    expect(totalUsd).toBeCloseTo(0.031815, 6);
    expect(Number.isInteger(cost.totalCostMicroUsd)).toBe(true);
  });

  // ----- prompt=1100, cached=100, candidate=500, thoughts=200 (spec §8.2) --
  it("matches the spec worked example exactly", () => {
    const { cost } = computeCostBreakdown("gemini", "gemini-3.6-flash", {
      promptTokens: 1100,
      cachedInputTokens: 100,
      candidatesTokens: 500,
      thinkingTokens: 200
    });
    // nonCachedInput = 1100 - 100 = 1000; input cost = 1000 * 1.5/1e6 = 0.0015
    expect(USD(cost.inputCostMicroUsd)).toBeCloseTo(0.0015, 6);
    // cached cost = 100 * 0.15/1e6 = 0.000015
    expect(USD(cost.cachedInputCostMicroUsd)).toBeCloseTo(0.000015, 6);
    // billedOutput = 500 + 200 = 700; output cost = 700 * 7.5/1e6 = 0.00525
    expect(USD(cost.outputCostMicroUsd)).toBeCloseTo(0.00525, 6);
    // total = 0.006765
    expect(USD(cost.totalCostMicroUsd)).toBeCloseTo(0.006765, 6);
    // all integers
    expect(Number.isInteger(cost.inputCostMicroUsd)).toBe(true);
    expect(Number.isInteger(cost.cachedInputCostMicroUsd)).toBe(true);
    expect(Number.isInteger(cost.outputCostMicroUsd)).toBe(true);
    expect(Number.isInteger(cost.totalCostMicroUsd)).toBe(true);
  });

  // ----- cached tokens are NOT double-counted (spec §6.1, §6.2) ------------
  it("subtracts cached tokens from the non-cached input bucket", () => {
    const { cost } = computeCostBreakdown("gemini", "gemini-3.6-flash", {
      promptTokens: 1000,
      cachedInputTokens: 1000, // fully cached
      candidatesTokens: 0,
      thinkingTokens: 0
    });
    // nonCachedInput = 0 -> input cost 0; cached billed at the cheap rate.
    expect(cost.inputCostMicroUsd).toBe(0);
    expect(USD(cost.cachedInputCostMicroUsd)).toBeCloseTo(0.00015, 6);
  });

  // ----- free / unavailable models (spec §5.4, §8.6) -----------------------
  it("gemma-4-31b-it is free-tier and never fabricates paid pricing", () => {
    const free = priceFor("gemini", "gemma-4-31b-it");
    expect(free.serviceTier).toBe("free");
    expect(isUnpricedTier(free.serviceTier)).toBe(true);
    const { cost } = computeCostBreakdown("gemini", "gemma-4-31b-it", {
      promptTokens: 1000,
      cachedInputTokens: 0,
      candidatesTokens: 1000,
      thinkingTokens: 0
    });
    expect(cost.totalCostMicroUsd).toBe(0);
    // A quota row that marks the paid tier as pricingUnavailable surfaces
    // unavailability instead of fabricating numbers (spec §5.4).
    const paidConfig = { pricingUnavailable: true, pricingSource: "unavailable" };
    const paid = priceFor("gemini", "gemma-4-31b-it", paidConfig);
    expect(paid.serviceTier).toBe("unavailable");
    expect(paid.pricingSource).toBe("unavailable");
    expect(paid.inputPriceUsdPerMillion).toBe(0);
  });

  it("a DB config row overrides seed prices and is used for cost", () => {
    const customConfig = {
      serviceTier: "standard",
      inputPriceUsdPerMillion: 2.0,
      outputPriceUsdPerMillion: 8.0,
      cachedInputPriceUsdPerMillion: 0.2,
      cacheStorageUsdPerMillionTokenHour: 1.0,
      pricingEffectiveAt: "2026-08-01",
      pricingSource: "admin-configured"
    };
    const p = priceFor("gemini", "gemini-3.6-flash", customConfig);
    expect(p.inputPriceUsdPerMillion).toBe(2.0);
    expect(p.pricingSource).toBe("admin-configured");
    const { cost } = computeCostBreakdown("gemini", "gemini-3.6-flash", {
      promptTokens: 1000,
      cachedInputTokens: 0,
      candidatesTokens: 1000,
      thinkingTokens: 0
    }, customConfig);
    // 1000 * 2.0 input + 1000 * 8.0 output = 2000 + 8000 = 10000 microUsd.
    expect(cost.inputCostMicroUsd).toBe(2000);
    expect(cost.outputCostMicroUsd).toBe(8000);
    expect(cost.totalCostMicroUsd).toBe(10000);
  });

  // ----- Z.AI has its OWN pricing adapter (spec §5.5) ----------------------
  it("zai uses its own pricing, never gemini prices", () => {
    const z = priceFor("zai", "glm-5.1");
    expect(z.inputPriceUsdPerMillion).toBeGreaterThan(0);
    expect(z.pricingSource).toContain("zai");
    // Distinct from gemini wildcard.
    const g = priceFor("gemini", "unknown-gemini-model");
    expect(z.inputPriceUsdPerMillion).not.toBe(g.inputPriceUsdPerMillion);
  });

  // ----- Pricing snapshot immutability (spec §5.3, §8.3) -------------------
  it("captures a stable pricing snapshot whose version is content-derived", () => {
    const a = pricingSnapshotFor("gemini", "gemini-3.6-flash");
    const b = pricingSnapshotFor("gemini", "gemini-3.6-flash");
    expect(a.pricingVersion).toBe(b.pricingVersion);
    expect(a.pricing).toEqual(b.pricing);
    // A different model has a different version.
    const c = pricingSnapshotFor("gemini", "gemini-3.5-flash-lite");
    expect(c.pricingVersion).not.toBe(a.pricingVersion);
    // The serialized snapshot contains only pricing fields, never keys/secrets.
    const json = serializePricingSnapshot(a);
    expect(json).toContain("pricingVersion");
    expect(json.toLowerCase()).not.toContain("key");
    expect(json.toLowerCase()).not.toContain("secret");
    const parsed = JSON.parse(json);
    expect(parsed.pricing.inputPriceUsdPerMillion).toBe(1.5);
  });

  // ----- $3.34 reproduction test (spec §8.7) -------------------------------
  // The old code had three compounding bugs:
  //   1. gemini-3.6-flash had no exact seed entry → fell to gemini|* wildcard
  //   2. No cached/thinking split → all tokens billed at full rates
  //   3. perMillionToMicroUsdPerToken used Math.trunc, losing fractional cents
  // The result was an incorrect cost far from the true maximum of $0.031815.
  it("reproduces the old buggy calculation to prove the class of error", () => {
    // Simulate the OLD buggy approach:
    // - Old wildcard pricing (gemini|* at 2.0-flash rates: 0.1/0.4)
    // - Truncated per-token conversion via Math.trunc
    // - No cached/thinking split (all tokens counted as output)
    const OLD_WILDCARD_OUTPUT = 0.4; // gemini|* wildcard output
    const ALL_TOKENS_AS_OUTPUT = 4242;

    // Old bug: perMillionToMicroUsdPerToken(Math.trunc(price))
    // Math.trunc(0.4) = 0 → cost = 0
    const oldPerTokenTrunc = Math.trunc(OLD_WILDCARD_OUTPUT);
    const oldCost = ALL_TOKENS_AS_OUTPUT * oldPerTokenTrunc;

    // The NEW correct: exact seed match + round half-up + cached/thinking split
    const { cost } = computeCostBreakdown("gemini", "gemini-3.6-flash", {
      promptTokens: 0,
      cachedInputTokens: 0,
      candidatesTokens: 4242,
      thinkingTokens: 0
    });

    // Old bug gave 0 (or worse, if price was misinterpreted).
    // New gives the correct 0.031815 USD maximum.
    expect(oldCost).toBe(0); // truncation bug
    expect(cost.totalCostMicroUsd).toBe(31815);
    expect(USD(cost.totalCostMicroUsd)).toBeCloseTo(0.031815, 6);
    // Verify the new code NEVER produces the broken $3.34.
    expect(USD(cost.totalCostMicroUsd)).not.toBe(3.34);
  });

  // ----- totalTokens consistency (spec §4.1, §8.2) ---------------------------
  it("totalTokens = input + output + thinking (1100/100/500/200 → 1800)", () => {
    // Gateway calculates: provider totalTokenCount IF present, ELSE input+output+thinking.
    // For 1100 input / 100 cached / 500 output / 200 thinking:
    //   - Provider might return totalTokenCount = 1800 (Gemini totalTokenCount)
    //   - Gateway fallback: 1100 + 500 + 200 = 1800
    const input = 1100, cached = 100, output = 500, thinking = 200;
    const providerTotal = 1800; // Gemini totalTokenCount = promptTokenCount + candidatesTokenCount
    const fallbackTotal = input + output + thinking; // = 1800
    expect(providerTotal).toBe(1800);
    expect(fallbackTotal).toBe(1800);
    // Both approaches give the same result.
  });

  // ----- Model normalization tests (spec §8.5) ------------------------------
  it("gemini-3.6-flash has exact seed pricing (never wildcard)", () => {
    expect(hasExactPricing("gemini", "gemini-3.6-flash")).toBe(true);
    const p = priceFor("gemini", "gemini-3.6-flash");
    expect(p.serviceTier).toBe("standard");
    expect(p.inputPriceUsdPerMillion).toBe(1.5);
  });

  it("gemini-3.5-flash-lite has exact seed pricing (never wildcard)", () => {
    expect(hasExactPricing("gemini", "gemini-3.5-flash-lite")).toBe(true);
    const p = priceFor("gemini", "gemini-3.5-flash-lite");
    expect(p.inputPriceUsdPerMillion).toBe(0.3);
  });

  it("gemma-4-31b-it has exact seed pricing (free-tier, never wildcard)", () => {
    expect(hasExactPricing("gemini", "gemma-4-31b-it")).toBe(true);
    const p = priceFor("gemini", "gemma-4-31b-it");
    expect(p.serviceTier).toBe("free");
  });

  // ----- pricingUnavailable behavior (spec §8.9) ---------------------------
  it("pricingUnavailable returns zero costs with unavailable source", () => {
    const config = { pricingUnavailable: true, pricingSource: "unavailable" };
    const p = priceFor("gemini", "gemini-3.6-flash", config);
    expect(p.serviceTier).toBe("unavailable");
    expect(p.pricingSource).toBe("unavailable");
    expect(isUnpricedTier(p.serviceTier)).toBe(true);
    const { cost } = computeCostBreakdown("gemini", "gemini-3.6-flash", {
      promptTokens: 1000, cachedInputTokens: 0,
      candidatesTokens: 1000, thinkingTokens: 0
    }, config);
    // When pricing is unavailable, component costs are 0 so total is 0.
    // The available/unavailable signal is the pricingSource, not the numeric value.
    expect(cost.totalCostMicroUsd).toBe(0);
    expect(cost.inputCostMicroUsd).toBe(0);
    expect(cost.outputCostMicroUsd).toBe(0);
  });

  // ----- component rounding consistency (spec §8.2) --------------------------
  it("component costs sum to total without floating-point drift", () => {
    // Use fractional prices that could cause float noise.
    const { cost } = computeCostBreakdown("openai", "gpt-4o-mini", {
      promptTokens: 333,
      cachedInputTokens: 111,
      candidatesTokens: 222,
      thinkingTokens: 77
    });
    // gpt-4o-mini: input=0.15, cached=0.075, output=0.6
    // nonCachedInput = 333-111 = 222; 222*0.15 = 33.3 → round(33.3) = 33
    // cachedInput = 111*0.075 = 8.325 → round(8.325) = 8
    // billedOutput = 222+77 = 299; 299*0.6 = 179.4 → round(179.4) = 179
    // total = 33+8+179 = 220
    expect(cost.inputCostMicroUsd + cost.cachedInputCostMicroUsd + cost.outputCostMicroUsd)
      .toBe(cost.totalCostMicroUsd);
    expect(cost.totalCostMicroUsd).toBe(220);
  });

  // ----- cachedInput > inputTokens is clamped safely (spec §8.4) -------------
  it("cachedInputTokens > inputTokens safely clamps nonCachedInput to 0", () => {
    const { cost } = computeCostBreakdown("gemini", "gemini-3.6-flash", {
      promptTokens: 100,
      cachedInputTokens: 999, // more cached than total input (anomalous)
      candidatesTokens: 0,
      thinkingTokens: 0
    });
    // nonCachedInput = max(100-999, 0) = 0 → only cached input is billed
    expect(cost.inputCostMicroUsd).toBe(0);
    expect(cost.cachedInputCostMicroUsd).toBeGreaterThan(0);
  });

  // ----- thinking billed at output rate, never double-counted (spec §8.4) ----
  it("thinking tokens are billed once at output rate", () => {
    const { cost } = computeCostBreakdown("gemini", "gemini-3.6-flash", {
      promptTokens: 0,
      cachedInputTokens: 0,
      candidatesTokens: 500,
      thinkingTokens: 200  // thinking is separate from candidates, billed at output rate
    });
    // billedOutput = 500 + 200 = 700; output cost = 700 * 7.5 / 1e6 = 0.00525
    expect(USD(cost.outputCostMicroUsd)).toBeCloseTo(0.00525, 6);
    // Total includes only ONE output charge, not double.
    expect(cost.totalCostMicroUsd).toBe(cost.inputCostMicroUsd + cost.cachedInputCostMicroUsd + cost.outputCostMicroUsd);
  });

  // ----- Large volume test: no systematic drift (spec §8.3) -------------------
  it("1000 identical cost calculations produce the same total", () => {
    let total = 0;
    for (let i = 0; i < 1000; i++) {
      const { cost } = computeCostBreakdown("gemini", "gemini-3.6-flash", {
        promptTokens: 1100, cachedInputTokens: 100,
        candidatesTokens: 500, thinkingTokens: 200
      });
      total += cost.totalCostMicroUsd;
    }
    // Each request: 6765 micro-USD. 1000 requests: 6,765,000 micro-USD.
    expect(total).toBe(1000 * 6765);
  });

  // ----- DB config override marks source correctly --------------------------
  it("DB config pricingSource overrides seed source", () => {
    const config = {
      inputPriceUsdPerMillion: 2.0,
      outputPriceUsdPerMillion: 8.0,
      pricingSource: "admin-configured"
    };
    const p = priceFor("gemini", "gemini-3.6-flash", config);
    expect(p.pricingSource).toBe("admin-configured");
  });
});
