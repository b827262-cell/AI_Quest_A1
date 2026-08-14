import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminDependencies } from "./dependencies";
import { createDbHandle } from "@ai-smartbook/db";
import {
  GUEST_ASK_RETENTION_DEFAULT_DAYS,
  GUEST_ASK_RETENTION_MAX_DAYS,
  GUEST_ASK_RETENTION_MIN_DAYS
} from "@ai-smartbook/ai";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * The dependency graph must resolve guest-ask retention through the shared
 * @ai-smartbook/ai contract (default 7, invalid/<=0 -> default, floor,
 * clamp to [MIN, MAX]). A plain `Number(env.X || 7)` bypass loses the
 * data-lifecycle boundary; these cases pin the integration boundary, not
 * just the resolver itself.
 */
function retentionDaysFor(envValue: string | undefined): number {
  const directory = mkdtempSync(join(tmpdir(), "ai-smartbook-retention-"));
  temporaryDirectories.push(directory);
  const dbHandle = createDbHandle(join(directory, "retention.db"));
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    AI_PROVIDER: "mock",
    AI_GATEWAY_ENABLED: "false",
    AI_CREDENTIAL_ENCRYPTION_KEY: "retention-test-encryption-key-0123456789",
    SQLITE_PATH: join(directory, "retention.db")
  };
  if (envValue !== undefined) env.GUEST_ASK_RETENTION_DAYS = envValue;
  const dependencies = createAdminDependencies({ env, dbHandle });
  dbHandle.sqlite.close();
  return dependencies.guestAskRetentionDays;
}

describe("admin dependency graph guest retention boundary", () => {
  it("RET-1 uses the shared default when GUEST_ASK_RETENTION_DAYS is unset", () => {
    expect(retentionDaysFor(undefined)).toBe(GUEST_ASK_RETENTION_DEFAULT_DAYS);
    expect(retentionDaysFor("")).toBe(GUEST_ASK_RETENTION_DEFAULT_DAYS);
  });

  it("RET-2 falls back to the shared default for non-numeric input", () => {
    expect(retentionDaysFor("abc")).toBe(GUEST_ASK_RETENTION_DEFAULT_DAYS);
  });

  it("RET-3 falls back to the shared default for zero and negative input", () => {
    expect(retentionDaysFor("0")).toBe(GUEST_ASK_RETENTION_DEFAULT_DAYS);
    expect(retentionDaysFor("-5")).toBe(GUEST_ASK_RETENTION_DEFAULT_DAYS);
  });

  it("RET-4 clamps positive fractional values below the minimum up to it", () => {
    expect(retentionDaysFor("0.5")).toBe(GUEST_ASK_RETENTION_MIN_DAYS);
  });

  it("RET-5 clamps values above the maximum down to it", () => {
    expect(retentionDaysFor("999")).toBe(GUEST_ASK_RETENTION_MAX_DAYS);
  });

  it("RET-6 floors fractional values inside the range", () => {
    expect(retentionDaysFor("12.8")).toBe(12);
  });

  it("RET-7 passes normal in-range values through unchanged", () => {
    expect(retentionDaysFor("30")).toBe(30);
  });
});
