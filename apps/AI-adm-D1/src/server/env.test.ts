import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRootEnv } from "./env";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("repository root environment loading", () => {
  it("loads ADMIN_API_TOKEN from the supplied root env without overriding the shell", () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-smartbook-env-test-"));
    temporaryDirectories.push(directory);
    const envPath = join(directory, ".env");
    writeFileSync(envPath, "ADMIN_API_TOKEN=file-value\nAI_CREDENTIAL_ENCRYPTION_KEY=file-vault-key\nOTHER_SETTING=from-file\n");
    const target: NodeJS.ProcessEnv = { ADMIN_API_TOKEN: "shell-value" };

    const result = loadRootEnv(envPath, target);

    expect(result.loaded).toBe(true);
    expect(result.adminTokenConfigured).toBe(true);
    expect(result.credentialEncryptionKeyConfigured).toBe(true);
    expect(target.ADMIN_API_TOKEN).toBe("shell-value");
    expect(target.OTHER_SETTING).toBe("from-file");
  });

  it("resolves the repository-root .env path independently of the caller cwd", () => {
    const target: NodeJS.ProcessEnv = {};
    const result = loadRootEnv(undefined, target);
    expect(result.path.endsWith("/AI-SmartBook-R1-PR4/.env")).toBe(true);
    expect(result.adminTokenConfigured).toBe(true);
    expect(result.credentialEncryptionKeyConfigured).toBe(true);
    expect(target.ADMIN_API_TOKEN).toBeTruthy();
  });
});
