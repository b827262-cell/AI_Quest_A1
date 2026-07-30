import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const envPath = resolve(root, ".env");

function existingToken(contents) {
  const match = contents.match(/^\s*ADMIN_API_TOKEN\s*=\s*(.*?)\s*$/m);
  if (!match) return undefined;
  const value = match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  return value || undefined;
}

function writeSecure(contents) {
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

function initToken() {
  const contents = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (existingToken(contents)) {
    chmodSync(envPath, 0o600);
    console.log("ADMIN_API_TOKEN: configured (existing value preserved)");
    return true;
  }
  const suffix = contents.length && !contents.endsWith("\n") ? "\n" : "";
  writeSecure(`${contents}${suffix}ADMIN_API_TOKEN=${randomBytes(32).toString("hex")}\n`);
  console.log("ADMIN_API_TOKEN: configured (new value initialized)");
  return true;
}

function checkToken() {
  if (!existsSync(envPath)) {
    console.error("ADMIN_API_TOKEN: missing (.env is absent; run ./reset-ai-smartbook.sh init-token)");
    return false;
  }
  const contents = readFileSync(envPath, "utf8");
  if (!existingToken(contents)) {
    console.error("ADMIN_API_TOKEN: missing (.env has no configured value)");
    return false;
  }
  chmodSync(envPath, 0o600);
  console.log("ADMIN_API_TOKEN: configured");
  return true;
}

const action = process.argv[2] || "--check";
const ok = action === "--init" ? initToken() : action === "--check" ? checkToken() : false;
if (!ok) {
  if (action !== "--check" && action !== "--init") console.error("Usage: node scripts/ensure-admin-token.mjs [--init|--check]");
  process.exitCode = 1;
}
