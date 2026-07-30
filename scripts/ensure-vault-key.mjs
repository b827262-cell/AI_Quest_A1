import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const defaultEnvPath = resolve(root, ".env");
const keyName = "AI_CREDENTIAL_ENCRYPTION_KEY";

function existingValue(contents, name = keyName) {
  const expression = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, "m");
  const match = contents.match(expression);
  if (!match) return undefined;
  const value = match[1].trim().replace(/^(?:\"([\s\S]*)\"|'([\s\S]*)')$/, "$1$2");
  return value || undefined;
}

function writeSecure(envPath, contents) {
  mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${envPath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, contents, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, envPath);
    chmodSync(envPath, 0o600);
  } finally {
    try { rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
  }
}

export function initVaultKey(envPath = defaultEnvPath) {
  const contents = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (existingValue(contents)) {
    chmodSync(envPath, 0o600);
    return "already-configured";
  }
  const suffix = contents.length && !contents.endsWith("\n") ? "\n" : "";
  // 32 random bytes encoded as base64url are deployment-grade key material.
  writeSecure(envPath, `${contents}${suffix}${keyName}=${randomBytes(32).toString("base64url")}\n`);
  return "configured";
}

export function checkVaultKey(envPath = defaultEnvPath) {
  if (!existsSync(envPath)) return false;
  const configured = Boolean(existingValue(readFileSync(envPath, "utf8")));
  if (configured) chmodSync(envPath, 0o600);
  return configured;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2] || "--check";
  if (action === "--init") {
    const result = initVaultKey();
    console.log(`AI_CREDENTIAL_ENCRYPTION_KEY: ${result === "already-configured" ? "already configured" : "configured"}`);
  } else if (action === "--check") {
    if (checkVaultKey()) console.log("AI_CREDENTIAL_ENCRYPTION_KEY: configured");
    else {
      console.error("AI_CREDENTIAL_ENCRYPTION_KEY: missing");
      process.exitCode = 1;
    }
  } else {
    console.error("Usage: node scripts/ensure-vault-key.mjs [--init|--check]");
    process.exitCode = 1;
  }
}
