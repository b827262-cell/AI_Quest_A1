import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkVaultKey, initVaultKey } from "../../../../scripts/ensure-vault-key.mjs";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function temporaryEnv(initial = "") {
  const directory = mkdtempSync(join(tmpdir(), "ai-smartbook-vault-init-"));
  directories.push(directory);
  const path = join(directory, ".env");
  if (initial) writeFileSync(path, initial);
  return path;
}

describe("vault key initializer", () => {
  it("creates a 32-byte base64url key once and preserves unrelated settings", () => {
    const path = temporaryEnv("ADMIN_API_TOKEN=existing\nOTHER_SETTING=preserve\n");
    expect(initVaultKey(path)).toBe("configured");
    const first = readFileSync(path, "utf8");
    const value = first.match(/^AI_CREDENTIAL_ENCRYPTION_KEY=(.+)$/m)?.[1];
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).toContain("ADMIN_API_TOKEN=existing");
    expect(first).toContain("OTHER_SETTING=preserve");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(initVaultKey(path)).toBe("already-configured");
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("reports missing and accepts an existing non-empty deployment key without replacing it", () => {
    const path = temporaryEnv();
    expect(checkVaultKey(path)).toBe(false);
    writeFileSync(path, "AI_CREDENTIAL_ENCRYPTION_KEY=deployment-managed-value\n");
    expect(checkVaultKey(path)).toBe(true);
    expect(initVaultKey(path)).toBe("already-configured");
    expect(readFileSync(path, "utf8")).toContain("AI_CREDENTIAL_ENCRYPTION_KEY=deployment-managed-value");
  });
});
