import { describe, expect, it } from "vitest";
import {
  createAiCredentialModelQuotaInputSchema,
  updateAiCredentialModelQuotaInputSchema
} from "../src/aiGateway.schema";

const emptyPricing = {
  currency: null,
  serviceTier: null,
  inputPriceUsdPerMillion: null,
  outputPriceUsdPerMillion: null,
  cachedInputPriceUsdPerMillion: null,
  cacheStorageUsdPerMillionTokenHour: null,
  pricingEffectiveAt: null,
  pricingSource: null,
  pricingUnavailable: false
} as const;

const emptyPricingQuota = {
  model: "gpt-5.6-luna",
  rpmLimit: null,
  tpmLimit: null,
  rpdLimit: null,
  resetTimezone: "Asia/Taipei",
  enabled: true,
  isDefault: false,
  ...emptyPricing
};

describe("AI credential model quota pricing schema", () => {
  it("accepts a create payload with every blank pricing field as null", () => {
    const result = createAiCredentialModelQuotaInputSchema.safeParse(emptyPricingQuota);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject(emptyPricing);
  });

  it("accepts null pricing fields in an update payload so existing prices can be cleared", () => {
    const result = updateAiCredentialModelQuotaInputSchema.safeParse(emptyPricing);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject(emptyPricing);
  });

  it("rejects unsupported service tiers", () => {
    expect(createAiCredentialModelQuotaInputSchema.safeParse({
      ...emptyPricingQuota,
      serviceTier: "enterprise"
    }).success).toBe(false);
  });

  it("rejects negative values for every price field", () => {
    const priceFields = [
      "inputPriceUsdPerMillion",
      "outputPriceUsdPerMillion",
      "cachedInputPriceUsdPerMillion",
      "cacheStorageUsdPerMillionTokenHour"
    ] as const;

    for (const field of priceFields) {
      expect(createAiCredentialModelQuotaInputSchema.safeParse({
        ...emptyPricingQuota,
        [field]: -0.01
      }).success).toBe(false);
    }
  });
});
