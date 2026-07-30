import { createDbHandle, resolveDbPath } from "../packages/db/src/client";
import {
  rotateCredentialKeys,
  verifyCredentialKeys
} from "../apps/AI-adm-D1/src/server/ai/credential-rotation";
import { loadRootEnv } from "../apps/AI-adm-D1/src/server/env";

function usage(): never {
  console.error("Usage: credential-key-rotation --dry-run | --execute | --verify");
  process.exit(2);
}

class RotationBlockedError extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new RotationBlockedError(`${name} is unavailable from the deployment secret environment`);
  return value;
}

function main(): void {
  const mode = process.argv[2];
  if (!mode || !["--dry-run", "--execute", "--verify"].includes(mode)) usage();

  // Match the API process: a deployment/secret-manager environment wins, and
  // the repository root .env is only the local-development fallback.
  loadRootEnv();

  let sqlite: ReturnType<typeof createDbHandle>["sqlite"] | undefined;
  try {
    const masterKey = mode === "--verify" ? required("AI_CREDENTIAL_ENCRYPTION_KEY") : undefined;
    const oldKey = mode === "--verify" ? undefined : required("AI_CREDENTIAL_OLD_KEY");
    const newKey = mode === "--verify" ? undefined : required("AI_CREDENTIAL_NEW_KEY");
    sqlite = createDbHandle(resolveDbPath()).sqlite;
    if (mode === "--verify") {
      const count = verifyCredentialKeys(sqlite, masterKey!);
      console.log(`Credential key verification: PASS (${count} credential(s))`);
      return;
    }

    const result = rotateCredentialKeys(sqlite, {
      oldKey: oldKey!,
      newKey: newKey!,
      dryRun: mode === "--dry-run"
    });
    console.log(`Credential key rotation: ${result.dryRun ? "DRY-RUN" : "PASS"}`);
    console.log(`Planned: ${result.planned}`);
    console.log(`Rotated: ${result.rotated}`);
    console.log(`Skipped: ${result.skipped}`);
    if (!result.dryRun) console.log("Audit: credential.master_key_rotated");
  } catch (error) {
    if (error instanceof RotationBlockedError) {
      console.error(`Credential key rotation: BLOCKED (${error.message})`);
      process.exitCode = 2;
      return;
    }
    console.error("Credential key rotation: FAIL (details redacted)");
    process.exitCode = 1;
  } finally {
    sqlite?.close();
  }
}

main();
