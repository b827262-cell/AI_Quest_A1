import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../src";

describe("gateway environment policy", () => {
  it("defaults mock fallback on outside production and off in production", () => {
    expect(loadGatewayConfig({ NODE_ENV: "development" }).allowMockFallback).toBe(true);
    expect(loadGatewayConfig({ NODE_ENV: "test" }).allowMockFallback).toBe(true);
    expect(loadGatewayConfig({ NODE_ENV: "production" }).allowMockFallback).toBe(false);
  });

  it("requires an explicit production opt-in for mock fallback", () => {
    expect(loadGatewayConfig({ NODE_ENV: "production", AI_ALLOW_MOCK_FALLBACK: "true" }).allowMockFallback)
      .toBe(true);
    expect(loadGatewayConfig({ NODE_ENV: "production", AI_ALLOW_MOCK_FALLBACK: "false" }).allowMockFallback)
      .toBe(false);
  });
});
