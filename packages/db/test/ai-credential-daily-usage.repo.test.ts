import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createRepositories } from "../src/repositories";
import { runMigrations } from "../src/migrate";
import { schema } from "../src/schema";
import type { Repositories } from "../src/repositories";

function setup() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  return { sqlite, repos: createRepositories(drizzle(sqlite, { schema })) };
}

/** Create N OpenAI credentials under one provider config; returns their ids. */
function makeOpenAiCredentials(repos: Repositories, count: number, provider: "openai" | "gemini" = "openai"): {
  providerConfigId: string; credentialIds: string[];
} {
  const cfg = repos.aiProviders.upsertConfig({ provider, displayName: provider === "openai" ? "OpenAI" : "Gemini", model: "gpt-test" });
  const credentialIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const credential = repos.aiProviders.createCredential({
      providerConfigId: cfg.id,
      name: `key-${i + 1}`,
      encryptedApiKey: `enc-${i}`,
      maskedApiKey: `sk-****${i}`,
      keyFingerprint: `fp-${provider}-${i}`,
      status: "active"
    });
    credentialIds.push(credential.id);
  }
  return { providerConfigId: cfg.id, credentialIds };
}

describe("OpenAI credential daily usage ledger", () => {
  let repos: Repositories;
  beforeEach(() => { repos = setup().repos; });

  it("lists only OpenAI credentials across all openai configs", () => {
    const openAi = makeOpenAiCredentials(repos, 4, "openai");
    const gemini = makeOpenAiCredentials(repos, 2, "gemini");
    const listed = repos.aiCredentialDailyUsage.listOpenAiCredentialIds();
    expect(listed).toHaveLength(4);
    expect(listed.every((row) => openAi.credentialIds.includes(row.credentialId))).toBe(true);
    expect(listed.some((row) => gemini.credentialIds.includes(row.credentialId))).toBe(false);
  });

  it("reserves independently per credential (four keys do not affect each other)", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 4);
    const [a, b, c, d] = credentialIds;
    repos.aiCredentialDailyUsage.updateLimit(a, { dailyTokenLimit: 100000, enabled: true });
    const rA = repos.aiCredentialDailyUsage.reserve({ requestId: "r1", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt-5.6", estimatedTokens: 32000, estimatedCostMicroUsd: 0 });
    const rB = repos.aiCredentialDailyUsage.reserve({ requestId: "r2", attempt: 0, credentialId: b, providerConfigId: "cfg", providerModel: "gpt-5.6", estimatedTokens: 68000, estimatedCostMicroUsd: 0 });
    const rC = repos.aiCredentialDailyUsage.reserve({ requestId: "r3", attempt: 0, credentialId: c, providerConfigId: "cfg", providerModel: "gpt-5.6", estimatedTokens: 12000, estimatedCostMicroUsd: 0 });
    const rD = repos.aiCredentialDailyUsage.reserve({ requestId: "r4", attempt: 0, credentialId: d, providerConfigId: "cfg", providerModel: "gpt-5.6", estimatedTokens: 4000, estimatedCostMicroUsd: 0 });
    expect([rA.allowed, rB.allowed, rC.allowed, rD.allowed]).toEqual([true, true, true, true]);
    const today = repos.aiCredentialDailyUsage.listTodayForCredentials(credentialIds);
    const used = (id: string) => today.find((u) => u.credentialId === id)?.reservedTokens ?? 0;
    expect([used(a), used(b), used(c), used(d)]).toEqual([32000, 68000, 12000, 4000]);
  });

  it("pool summary aggregates four keys (32K+68K+12K+4K = 116K)", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 4);
    const amounts = [32000, 68000, 12000, 4000];
    credentialIds.forEach((id, i) => {
      repos.aiCredentialDailyUsage.updateLimit(id, { dailyTokenLimit: 100000, enabled: true });
      repos.aiCredentialDailyUsage.reserve({ requestId: `r${i}`, attempt: 0, credentialId: id, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: amounts[i], estimatedCostMicroUsd: 0 });
      repos.aiCredentialDailyUsage.settle({ reservationKey: `r${i}:0:${id}:gpt`, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: amounts[i], actualCostMicroUsd: 0, costSource: "priced" });
    });
    const today = repos.aiCredentialDailyUsage.listTodayForCredentials(credentialIds);
    const total = today.reduce((sum, u) => sum + u.usedTokens, 0);
    expect(total).toBe(116000);
    expect(today).toHaveLength(4);
  });

  it("exhausting one key does not affect others", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 2);
    const [a, b] = credentialIds;
    repos.aiCredentialDailyUsage.updateLimit(a, { dailyTokenLimit: 100, enabled: true });
    repos.aiCredentialDailyUsage.updateLimit(b, { dailyTokenLimit: 100, enabled: true });
    const first = repos.aiCredentialDailyUsage.reserve({ requestId: "r1", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 60, estimatedCostMicroUsd: 0 });
    const second = repos.aiCredentialDailyUsage.reserve({ requestId: "r2", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 50, estimatedCostMicroUsd: 0 });
    const bOk = repos.aiCredentialDailyUsage.reserve({ requestId: "r3", attempt: 0, credentialId: b, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 50, estimatedCostMicroUsd: 0 });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe("credential_daily_token_exhausted");
    expect(bOk.allowed).toBe(true);
  });

  it("supports different daily limits per key", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 2);
    const [a, b] = credentialIds;
    repos.aiCredentialDailyUsage.updateLimit(a, { dailyTokenLimit: 50000, enabled: true });
    repos.aiCredentialDailyUsage.updateLimit(b, { dailyTokenLimit: 200000, enabled: true });
    expect(repos.aiCredentialDailyUsage.findLimit(a)?.dailyTokenLimit).toBe(50000);
    expect(repos.aiCredentialDailyUsage.findLimit(b)?.dailyTokenLimit).toBe(200000);
  });

  it("reserve/settle/release are idempotent", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 1);
    const [a] = credentialIds;
    repos.aiCredentialDailyUsage.updateLimit(a, { dailyTokenLimit: 1000, enabled: true });
    const input = { requestId: "r1", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 100, estimatedCostMicroUsd: 0 };
    const r1 = repos.aiCredentialDailyUsage.reserve(input);
    const r2 = repos.aiCredentialDailyUsage.reserve(input);
    expect(r2.allowed).toBe(true);
    expect(r2.reservationKey).toBe(r1.reservationKey);
    const settleInput = { reservationKey: r1.reservationKey!, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 80, actualCostMicroUsd: 0, costSource: "priced" as const };
    repos.aiCredentialDailyUsage.settle(settleInput);
    repos.aiCredentialDailyUsage.settle(settleInput);
    const today = repos.aiCredentialDailyUsage.listTodayForCredentials([a]);
    expect(today[0].usedTokens).toBe(80);
    expect(today[0].requestCount).toBe(1);
  });

  it("release returns reserved tokens and is idempotent", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 1);
    const [a] = credentialIds;
    repos.aiCredentialDailyUsage.updateLimit(a, { dailyTokenLimit: 1000, enabled: true });
    const r = repos.aiCredentialDailyUsage.reserve({ requestId: "r1", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 100, estimatedCostMicroUsd: 0 });
    repos.aiCredentialDailyUsage.release(r.reservationKey!);
    repos.aiCredentialDailyUsage.release(r.reservationKey!);
    const today = repos.aiCredentialDailyUsage.listTodayForCredentials([a]);
    expect(today[0].reservedTokens).toBe(0);
    expect(today[0].usedTokens).toBe(0);
  });

  it("settle records overage when actual > estimated", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 1);
    const [a] = credentialIds;
    repos.aiCredentialDailyUsage.updateLimit(a, { dailyTokenLimit: 1000, enabled: true });
    const r = repos.aiCredentialDailyUsage.reserve({ requestId: "r1", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 100, estimatedCostMicroUsd: 0 });
    repos.aiCredentialDailyUsage.settle({ reservationKey: r.reservationKey!, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 150, actualCostMicroUsd: 0, costSource: "priced" });
    const today = repos.aiCredentialDailyUsage.listTodayForCredentials([a]);
    expect(today[0].usedTokens).toBe(150);
  });

  it("unconfigured cost source keeps actualCostMicroUsd=0 but records tokens", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 1);
    const [a] = credentialIds;
    repos.aiCredentialDailyUsage.updateLimit(a, { dailyTokenLimit: 1000, enabled: true });
    const r = repos.aiCredentialDailyUsage.reserve({ requestId: "r1", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 100, estimatedCostMicroUsd: 0 });
    repos.aiCredentialDailyUsage.settle({ reservationKey: r.reservationKey!, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 100, actualCostMicroUsd: 0, costSource: "unconfigured" });
    const today = repos.aiCredentialDailyUsage.listTodayForCredentials([a]);
    expect(today[0].costSource).toBe("unconfigured");
    expect(today[0].actualCostMicroUsd).toBe(0);
    expect(today[0].totalTokens).toBe(100);
  });

  it("cost limit exhaustion compensates the token reservation", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 1);
    const [a] = credentialIds;
    repos.aiCredentialDailyUsage.updateLimit(a, { dailyTokenLimit: 10000, dailyCostLimitMicroUsd: 100, enabled: true });
    const r = repos.aiCredentialDailyUsage.reserve({ requestId: "r1", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 100, estimatedCostMicroUsd: 50 });
    expect(r.allowed).toBe(true);
    const r2 = repos.aiCredentialDailyUsage.reserve({ requestId: "r2", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 100, estimatedCostMicroUsd: 60 });
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe("credential_daily_cost_exhausted");
    const today = repos.aiCredentialDailyUsage.listTodayForCredentials([a]);
    expect(today[0].reservedTokens).toBe(100);
    expect(today[0].reservedCostMicroUsd).toBe(50);
  });

  it("crosses local midnight into a new usage row (old day unchanged)", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 1);
    const [a] = credentialIds;
    repos.aiCredentialDailyUsage.updateLimit(a, { dailyTokenLimit: 1000, enabled: true });
    const day1 = new Date("2026-07-30T10:00:00Z");
    const r1 = repos.aiCredentialDailyUsage.reserve({ requestId: "r1", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 100, estimatedCostMicroUsd: 0 }, day1);
    repos.aiCredentialDailyUsage.settle({ reservationKey: r1.reservationKey!, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 100, actualCostMicroUsd: 0, costSource: "priced" }, day1);
    const day2 = new Date("2026-07-31T10:00:00Z");
    const r2 = repos.aiCredentialDailyUsage.reserve({ requestId: "r2", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 50, estimatedCostMicroUsd: 0 }, day2);
    expect(r2.allowed).toBe(true);
    const history = repos.aiCredentialDailyUsage.listHistory(a, "2026-07-01", "2026-12-31");
    expect(history).toHaveLength(2);
    const day1Row = history.find((h) => h.usageDate.startsWith("2026-07-30"));
    const day2Row = history.find((h) => h.usageDate.startsWith("2026-07-31"));
    expect(day1Row?.usedTokens).toBe(100);
    expect(day2Row?.reservedTokens).toBe(50);
  });

  it("unconfigured credential (no limit / disabled) is unlimited and still records reservations", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 1);
    const [a] = credentialIds;
    const r = repos.aiCredentialDailyUsage.reserve({ requestId: "r1", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 100, estimatedCostMicroUsd: 0 });
    expect(r.allowed).toBe(true);
    const today = repos.aiCredentialDailyUsage.listTodayForCredentials([a]);
    expect(today[0].reservedTokens).toBe(100);
  });

  it("releases stale pending reservations (crash recovery)", () => {
    const { credentialIds } = makeOpenAiCredentials(repos, 1);
    const [a] = credentialIds;
    repos.aiCredentialDailyUsage.updateLimit(a, { dailyTokenLimit: 1000, enabled: true });
    repos.aiCredentialDailyUsage.reserve({ requestId: "r1", attempt: 0, credentialId: a, providerConfigId: "cfg", providerModel: "gpt", estimatedTokens: 100, estimatedCostMicroUsd: 0 });
    const count = repos.aiCredentialDailyUsage.releaseStalePending(new Date().toISOString());
    expect(count).toBe(1);
    const today = repos.aiCredentialDailyUsage.listTodayForCredentials([a]);
    expect(today[0].reservedTokens).toBe(0);
  });
});

describe("OpenAI credential daily usage migration / backfill", () => {
  it("backfills one limit row per OpenAI credential, none for non-OpenAI", () => {
    const { sqlite, repos } = setup();
    const openAi = makeOpenAiCredentials(repos, 4, "openai");
    const gemini = makeOpenAiCredentials(repos, 2, "gemini");
    // Re-run migrations (idempotent) to trigger backfill again.
    runMigrations(sqlite);
    openAi.credentialIds.forEach((id) => {
      const limit = repos.aiCredentialDailyUsage.findLimit(id);
      expect(limit).toBeDefined();
      expect(limit?.enabled).toBe(false);
      expect(limit?.dailyTokenLimit).toBeNull();
    });
    gemini.credentialIds.forEach((id) => {
      expect(repos.aiCredentialDailyUsage.findLimit(id)).toBeUndefined();
    });
  });

  it("re-running migration twice does not create duplicate limit rows", () => {
    const { sqlite, repos } = setup();
    makeOpenAiCredentials(repos, 3, "openai");
    runMigrations(sqlite);
    runMigrations(sqlite);
    const listed = repos.aiCredentialDailyUsage.listOpenAiCredentialIds();
    listed.forEach((row) => {
      expect(repos.aiCredentialDailyUsage.findLimit(row.credentialId)).toBeDefined();
    });
  });

  it("backfills across multiple OpenAI provider configs", () => {
    const { repos } = setup();
    const cfg1 = repos.aiProviders.upsertConfig({ provider: "openai", displayName: "OpenAI A", model: "gpt" });
    const cfg2 = repos.aiProviders.upsertConfig({ provider: "openai", displayName: "OpenAI B", model: "gpt" });
    repos.aiProviders.createCredential({ providerConfigId: cfg1.id, name: "k1", encryptedApiKey: "e1", maskedApiKey: "sk-****1", keyFingerprint: "fp-oa-1", status: "active" });
    repos.aiProviders.createCredential({ providerConfigId: cfg2.id, name: "k2", encryptedApiKey: "e2", maskedApiKey: "sk-****2", keyFingerprint: "fp-oa-2", status: "active" });
    const listed = repos.aiCredentialDailyUsage.listOpenAiCredentialIds();
    expect(listed).toHaveLength(2);
  });
});
