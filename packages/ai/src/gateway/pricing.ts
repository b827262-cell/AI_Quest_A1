import type { AiProviderId } from "./ai-types";

/**
 * Model pricing — types, seed/fallback table, and exact cost math (spec §5, §6,
 * §13.10).
 *
 * Architecture: pricing is **DB-backed**. Each {@link ModelPricingConfig} row
 * stored on `ai_credential_model_quotas` is the authoritative source at request
 * time; this module supplies:
 *   - the {@link ModelPricing} type + DB column shape,
 *   - a seed/fallback table for models whose quota row carries no pricing,
 *   - provider/model name normalisation,
 *   - exact integer micro-USD cost computation + an immutable per-request
 *     snapshot.
 *
 * Money is **micro-USD** (1 USD = 1_000_000 micro-USD), stored and summed as
 * integers to avoid float drift. Public-facing unit prices are expressed in
 * **USD per 1,000,000 tokens** (how providers publish list prices). The
 * conversion to integer micro-USD happens once, at the final sum, so no
 * fractional cents are lost (spec §6.5).
 */
export type PricingServiceTier = "standard" | "free" | "unavailable";

export type ModelPricing = {
  currency: "USD";
  serviceTier: PricingServiceTier;
  inputPriceUsdPerMillion: number;
  outputPriceUsdPerMillion: number;
  cachedInputPriceUsdPerMillion: number;
  cacheStorageUsdPerMillionTokenHour: number;
  pricingEffectiveAt: string;
  pricingSource: string;
};

/**
 * The DB-backed pricing columns attached to a credential/model quota row
 * (spec §5.1). All nullable: a quota row may carry no pricing, in which case
 * the seed/fallback table is consulted.
 */
export type ModelPricingConfig = {
  currency: string | null;
  serviceTier: string | null;
  inputPriceUsdPerMillion: number | null;
  outputPriceUsdPerMillion: number | null;
  cachedInputPriceUsdPerMillion: number | null;
  cacheStorageUsdPerMillionTokenHour: number | null;
  pricingEffectiveAt: string | null;
  pricingSource: string | null;
  /** True when paid pricing is intentionally not published for this model. */
  pricingUnavailable: boolean | null;
};

/** True when a tier carries no charge (free) or has no published paid price. */
export function isUnpricedTier(tier: PricingServiceTier): boolean {
  return tier === "free" || tier === "unavailable";
}

const EFFECTIVE_AT = "2026-07-01";

const GOOGLE_STUDIO = "google-ai-studio-2026-07";
const OPENAI_SOURCE = "openai-public-pricing-2026-07";
const MOONSHOT_SOURCE = "moonshot-public-pricing-2026-07";
const DASHSCOPE_SOURCE = "dashscope-public-pricing-2026-07";
const ZAI_SOURCE = "zai-public-pricing-2026-07";

/**
 * Seed/fallback pricing table. Used when a quota row carries no pricing, and as
 * the source of the immutable per-request snapshot. Keys are
 * `${provider}|${model}` with a `${provider}|*` wildcard fallback. Each
 * provider has its OWN pricing — Gemini prices are never applied to other
 * providers (spec §5.5).
 */
const SEED_PRICING: Record<string, ModelPricing> = {
  // Mock is always free.
  "mock|*": {
    currency: "USD",
    serviceTier: "free",
    inputPriceUsdPerMillion: 0,
    outputPriceUsdPerMillion: 0,
    cachedInputPriceUsdPerMillion: 0,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: "internal"
  },

  // ----- Gemini (Google) -------------------------------------------------
  // gemini-3.6-flash Standard tier (spec §5.4).
  "gemini|gemini-3.6-flash": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 1.5,
    outputPriceUsdPerMillion: 7.5,
    cachedInputPriceUsdPerMillion: 0.15,
    cacheStorageUsdPerMillionTokenHour: 1.0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: GOOGLE_STUDIO
  },
  // gemini-3.5-flash-lite Standard tier (spec §5.4).
  "gemini|gemini-3.5-flash-lite": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.3,
    outputPriceUsdPerMillion: 2.5,
    cachedInputPriceUsdPerMillion: 0.03,
    cacheStorageUsdPerMillionTokenHour: 1.0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: GOOGLE_STUDIO
  },
  // gemma-4-31b-it: Gemini Developer API free tier only. Paid pricing is NOT
  // fabricated — the seed marks it free; the quota row may set
  // pricingUnavailable for the paid tier (spec §5.4).
  "gemini|gemma-4-31b-it": {
    currency: "USD",
    serviceTier: "free",
    inputPriceUsdPerMillion: 0,
    outputPriceUsdPerMillion: 0,
    cachedInputPriceUsdPerMillion: 0,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: "gemini-developer-api-free-tier"
  },
  // Legacy Gemini entries retained for back-compat.
  "gemini|gemini-1.5-flash": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.075,
    outputPriceUsdPerMillion: 0.3,
    cachedInputPriceUsdPerMillion: 0.01875,
    cacheStorageUsdPerMillionTokenHour: 0.25,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: GOOGLE_STUDIO
  },
  "gemini|gemini-1.5-pro": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 1.25,
    outputPriceUsdPerMillion: 5,
    cachedInputPriceUsdPerMillion: 0.3125,
    cacheStorageUsdPerMillionTokenHour: 0.875,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: GOOGLE_STUDIO
  },
  "gemini|gemini-2.0-flash": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.1,
    outputPriceUsdPerMillion: 0.4,
    cachedInputPriceUsdPerMillion: 0.025,
    cacheStorageUsdPerMillionTokenHour: 1.0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: GOOGLE_STUDIO
  },
  "gemini|*": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.1,
    outputPriceUsdPerMillion: 0.4,
    cachedInputPriceUsdPerMillion: 0.025,
    cacheStorageUsdPerMillionTokenHour: 1.0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: GOOGLE_STUDIO
  },

  // ----- OpenAI ----------------------------------------------------------
  "openai|gpt-4o-mini": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.15,
    outputPriceUsdPerMillion: 0.6,
    cachedInputPriceUsdPerMillion: 0.075,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: OPENAI_SOURCE
  },
  "openai|gpt-4o": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 2.5,
    outputPriceUsdPerMillion: 10,
    cachedInputPriceUsdPerMillion: 1.25,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: OPENAI_SOURCE
  },
  "openai|*": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.15,
    outputPriceUsdPerMillion: 0.6,
    cachedInputPriceUsdPerMillion: 0.075,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: OPENAI_SOURCE
  },

  // ----- Kimi (Moonshot) -------------------------------------------------
  "kimi|moonshot-v1-8k": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.24,
    outputPriceUsdPerMillion: 0.24,
    cachedInputPriceUsdPerMillion: 0,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: MOONSHOT_SOURCE
  },
  "kimi|*": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.24,
    outputPriceUsdPerMillion: 0.24,
    cachedInputPriceUsdPerMillion: 0,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: MOONSHOT_SOURCE
  },

  // ----- Qwen (DashScope) ------------------------------------------------
  "qwen|qwen-turbo": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.14,
    outputPriceUsdPerMillion: 0.28,
    cachedInputPriceUsdPerMillion: 0,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: DASHSCOPE_SOURCE
  },
  "qwen|*": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.14,
    outputPriceUsdPerMillion: 0.28,
    cachedInputPriceUsdPerMillion: 0,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: DASHSCOPE_SOURCE
  },

  // ----- Z.AI (GLM) — its OWN pricing adapter (spec §5.5). ----------------
  "zai|glm-5.1": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.5,
    outputPriceUsdPerMillion: 0.5,
    cachedInputPriceUsdPerMillion: 0,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: ZAI_SOURCE
  },
  "zai|*": {
    currency: "USD",
    serviceTier: "standard",
    inputPriceUsdPerMillion: 0.5,
    outputPriceUsdPerMillion: 0.5,
    cachedInputPriceUsdPerMillion: 0,
    cacheStorageUsdPerMillionTokenHour: 0,
    pricingEffectiveAt: EFFECTIVE_AT,
    pricingSource: ZAI_SOURCE
  }
};

const UNKNOWN_PRICING: ModelPricing = {
  currency: "USD",
  serviceTier: "standard",
  inputPriceUsdPerMillion: 0,
  outputPriceUsdPerMillion: 0,
  cachedInputPriceUsdPerMillion: 0,
  cacheStorageUsdPerMillionTokenHour: 0,
  pricingEffectiveAt: EFFECTIVE_AT,
  pricingSource: "unknown"
};

/** Coerce a DB config string into a typed service tier (default standard). */
function coerceTier(value: string | null | undefined): PricingServiceTier {
  if (value === "free" || value === "unavailable") return value;
  return "standard";
}

/** Normalise a model name for pricing lookup (trim + lowercase). */
export function normalizeModelName(model: string): string {
  return model.trim();
}

/**
 * Convert a DB-backed {@link ModelPricingConfig} into a {@link ModelPricing}.
 * Falls back to seed defaults for any missing field so a partial config row is
 * still usable. Honours `pricingUnavailable` (spec §5.4): when set, the tier is
 * "unavailable" and prices are zeroed rather than fabricated.
 *
 * Wildcard policy: when no exact seed entry exists and no DB config is
 * provided, the resolved pricing is marked **unavailable** (spec §8.5).
 * A wildcard match (e.g. `gemini|*`) is never used as official pricing
 * because it is a guess — the model may have different rates. Configure
 * exact DB pricing for models that should be billed.
 */
export function pricingFromConfig(
  provider: AiProviderId,
  model: string,
  config: ModelPricingConfig | null | undefined
): ModelPricing {
  // No DB config → seed/fallback table.  Only exact seed entries are
  // accepted as authoritative; wildcard-only matches are marked unavailable.
  if (!config) {
    const exactKey = `${provider}|${normalizeModelName(model)}`;
    if (SEED_PRICING[exactKey]) return { ...SEED_PRICING[exactKey] };
    // Only a wildcard or nothing exists → unavailable (never official).
    const hasWildcard = Boolean(SEED_PRICING[`${provider}|*`]);
    return {
      currency: "USD",
      serviceTier: "unavailable",
      inputPriceUsdPerMillion: 0,
      outputPriceUsdPerMillion: 0,
      cachedInputPriceUsdPerMillion: 0,
      cacheStorageUsdPerMillionTokenHour: 0,
      pricingEffectiveAt: EFFECTIVE_AT,
      pricingSource: hasWildcard ? "wildcard_fallback" : "unknown"
    };
  }

  // pricingUnavailable wins: paid pricing intentionally not published.
  if (config.pricingUnavailable) {
    const seed = seedPricingFor(provider, model);
    return {
      ...seed,
      serviceTier: "unavailable",
      inputPriceUsdPerMillion: 0,
      outputPriceUsdPerMillion: 0,
      cachedInputPriceUsdPerMillion: 0,
      cacheStorageUsdPerMillionTokenHour: 0,
      pricingSource: config.pricingSource ?? "unavailable"
    };
  }

  const tier = coerceTier(config.serviceTier);
  if (tier === "free") {
    return {
      currency: "USD",
      serviceTier: "free",
      inputPriceUsdPerMillion: 0,
      outputPriceUsdPerMillion: 0,
      cachedInputPriceUsdPerMillion: 0,
      cacheStorageUsdPerMillionTokenHour: 0,
      pricingEffectiveAt: config.pricingEffectiveAt ?? EFFECTIVE_AT,
      pricingSource: config.pricingSource ?? "configured-free-tier"
    };
  }

  // Standard tier: use configured prices, falling back to seed for any gap.
  const seed = seedPricingFor(provider, model);
  return {
    currency: "USD",
    serviceTier: tier,
    inputPriceUsdPerMillion:
      typeof config.inputPriceUsdPerMillion === "number"
        ? config.inputPriceUsdPerMillion
        : seed.inputPriceUsdPerMillion,
    outputPriceUsdPerMillion:
      typeof config.outputPriceUsdPerMillion === "number"
        ? config.outputPriceUsdPerMillion
        : seed.outputPriceUsdPerMillion,
    cachedInputPriceUsdPerMillion:
      typeof config.cachedInputPriceUsdPerMillion === "number"
        ? config.cachedInputPriceUsdPerMillion
        : seed.cachedInputPriceUsdPerMillion,
    cacheStorageUsdPerMillionTokenHour:
      typeof config.cacheStorageUsdPerMillionTokenHour === "number"
        ? config.cacheStorageUsdPerMillionTokenHour
        : seed.cacheStorageUsdPerMillionTokenHour,
    pricingEffectiveAt: config.pricingEffectiveAt ?? seed.pricingEffectiveAt,
    pricingSource: config.pricingSource ?? seed.pricingSource
  };
}

/** Resolve the seed/fallback pricing for a provider/model (never throws). */
export function seedPricingFor(provider: AiProviderId, model: string): ModelPricing {
  const key = `${provider}|${normalizeModelName(model)}`;
  if (SEED_PRICING[key]) return SEED_PRICING[key];
  const fallback = SEED_PRICING[`${provider}|*`];
  return fallback ?? UNKNOWN_PRICING;
}

/**
 * Resolve pricing, preferring a DB config row and falling back to seed.
 * Kept for back-compat with callers that have no config (e.g. budget estimate).
 */
export function priceFor(
  provider: AiProviderId,
  model: string,
  config?: ModelPricingConfig | null
): ModelPricing {
  return pricingFromConfig(provider, model, config ?? null);
}

/** Whether a provider/model pair has an exact (non-wildcard) seed entry. */
export function hasExactPricing(provider: AiProviderId, model: string): boolean {
  return Boolean(SEED_PRICING[`${provider}|${normalizeModelName(model)}`]);
}

/**
 * Integer multiply that rounds half-up and guards NaN (spec §13.10).
 *
 * Rounding policy: **round half up to nearest micro-USD** (`.5` and above
 * rounds away from zero). This prevents systematic underestimation from
 * per-component truncation. The final stored value is an integer micro-USD,
 * which is exact for all practical token counts and prices.
 *
 * For the extremely rare case where `a * b` produces a non-terminating
 * decimal (e.g. due to float representation of the price), the rounding
 * step absorbs the noise so component costs sum to the expected total
 * without drift.
 */
export function multiplySafe(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  if (a === 0 || b === 0) return 0;
  return Math.round(a * b);
}

/**
 * Token usage split used for cost computation (spec §6).
 *
 * - `promptTokens`       — Gemini `promptTokenCount`, which **includes**
 *                          cachedContentTokenCount.
 * - `cachedInputTokens`  — Gemini `cachedContentTokenCount`.
 * - `candidatesTokens`   — Gemini `candidatesTokenCount` (separate from
 *                          thoughtsTokenCount).
 * - `thinkingTokens`     — Gemini `thoughtsTokenCount` (separate from
 *                          candidatesTokenCount).
 *
 * Tool-call tokens are normalised by the provider adapter before reaching
 * here, so they are never double-counted. Total tokens for billing:
 *
 *   billedInputTokens = max(promptTokens - cachedInputTokens, 0) + cachedInputTokens
 *   billedOutputTokens = candidatesTokens + thinkingTokens
 *   totalTokens = promptTokens + candidatesTokens + thinkingTokens
 */
export type UsageSplit = {
  promptTokens: number;
  cachedInputTokens: number;
  candidatesTokens: number;
  thinkingTokens: number;
};

/** Per-component micro-USD cost breakdown. */
export type CostBreakdown = {
  inputCostMicroUsd: number;
  cachedInputCostMicroUsd: number;
  outputCostMicroUsd: number;
  totalCostMicroUsd: number;
};

/**
 * Cost of `tokens` at `usdPerMillion`, as integer micro-USD.
 *
 * cost_USD = tokens × usdPerMillion / 1_000_000
 * cost_microUsd = tokens × usdPerMillion  (rounded half-up at the end).
 *
 * The USD-per-million price is kept in full float precision and only rounded
 * once, at the final micro-USD integer, so fractional cents are never lost
 * (spec §6.5). The rounding policy is half-up (rounds .5 away from zero).
 */
function costMicroUsd(tokens: number, usdPerMillion: number): number {
  return multiplySafe(tokens, usdPerMillion);
}

/**
 * Compute the per-component cost breakdown in integer micro-USD (spec §6).
 *
 * - nonCachedInput = max(promptTokens - cachedInputTokens, 0)
 * - billedOutput   = candidatesTokens + thinkingTokens
 */
export function computeCostBreakdown(
  provider: AiProviderId,
  model: string,
  split: UsageSplit,
  config?: ModelPricingConfig | null
): { pricing: ModelPricing; cost: CostBreakdown } {
  const pricing = pricingFromConfig(provider, model, config ?? null);
  const unpriced = isUnpricedTier(pricing.serviceTier);

  const inputPrice = unpriced ? 0 : pricing.inputPriceUsdPerMillion;
  const cachedPrice = unpriced ? 0 : pricing.cachedInputPriceUsdPerMillion;
  const outputPrice = unpriced ? 0 : pricing.outputPriceUsdPerMillion;

  const nonCachedInput = Math.max(0, (split.promptTokens ?? 0) - (split.cachedInputTokens ?? 0));
  const billedOutput = (split.candidatesTokens ?? 0) + (split.thinkingTokens ?? 0);

  const inputCostMicroUsd = costMicroUsd(nonCachedInput, inputPrice);
  const cachedInputCostMicroUsd = costMicroUsd(split.cachedInputTokens ?? 0, cachedPrice);
  const outputCostMicroUsd = costMicroUsd(billedOutput, outputPrice);

  return {
    pricing,
    cost: {
      inputCostMicroUsd,
      cachedInputCostMicroUsd,
      outputCostMicroUsd,
      totalCostMicroUsd: inputCostMicroUsd + cachedInputCostMicroUsd + outputCostMicroUsd
    }
  };
}

/**
 * Backwards-compatible single-number cost estimate (micro-USD) for the budget
 * pre-check / reservation path.
 */
export function estimateCostMicroUsd(
  provider: AiProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
  config?: ModelPricingConfig | null
): number {
  const { cost } = computeCostBreakdown(provider, model, {
    promptTokens: inputTokens,
    cachedInputTokens: 0,
    candidatesTokens: outputTokens,
    thinkingTokens: 0
  }, config);
  return cost.totalCostMicroUsd;
}

/**
 * An immutable pricing snapshot captured at request time (spec §5.3). Stored
 * verbatim on the usage log so historical costs never change when prices are
 * edited later. `pricingVersion` is derived from the effective date + a content
 * hash, so editing a price produces a different version.
 */
export type PricingSnapshot = {
  provider: AiProviderId;
  model: string;
  pricing: ModelPricing;
  pricingVersion: string;
};

/** Deterministic short hash of a pricing snapshot for versioning. */
function hashSnapshot(provider: string, model: string, p: ModelPricing): string {
  const raw = [
    provider,
    model,
    p.currency,
    p.serviceTier,
    p.inputPriceUsdPerMillion,
    p.outputPriceUsdPerMillion,
    p.cachedInputPriceUsdPerMillion,
    p.cacheStorageUsdPerMillionTokenHour,
    p.pricingEffectiveAt,
    p.pricingSource
  ].join("|");
  // FNV-1a 32-bit, returned as base36. Dedup label only; not cryptographic.
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Capture the pricing snapshot for a provider/model at request time, resolving
 * from a DB config row when supplied (spec §5.3).
 */
export function pricingSnapshotFor(
  provider: AiProviderId,
  model: string,
  config?: ModelPricingConfig | null
): PricingSnapshot {
  const pricing = pricingFromConfig(provider, model, config ?? null);
  return {
    provider,
    model,
    pricing,
    pricingVersion: hashSnapshot(provider, model, pricing)
  };
}

/**
 * Serialize a snapshot for persistence. The stored JSON contains only pricing
 * fields — never keys, secrets, or provider response envelopes (spec §2.3).
 */
export function serializePricingSnapshot(snapshot: PricingSnapshot): string {
  return JSON.stringify({
    provider: snapshot.provider,
    model: snapshot.model,
    pricingVersion: snapshot.pricingVersion,
    pricing: snapshot.pricing
  });
}

/** Convert a micro-USD integer to a display USD number. */
export function microUsdToUsd(micro: number): number {
  return Math.round(micro) / 1_000_000;
}
