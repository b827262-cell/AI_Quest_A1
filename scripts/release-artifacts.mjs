import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

const SENSITIVE_KEYS = /^(?:api[_-]?key|encryptedapikey|keyfingerprint|fingerprint|authorization|x-admin-token|cookie|masterkey|oldkey|newkey|secret|iv|tag|access_token|refresh_token)$/i;
const SENSITIVE_OBJECT_KEYS = /^(?:headers|requestheaders|responseheaders|cookies|authorization|providerresponse|providererror|rawresponse|rawerror|encryptedpayload)$/i;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/i,
  /AIza[A-Za-z0-9_-]{30,}/,
  /(?:authorization|x-admin-token|bearer)\s*[:=]\s*[^\s,;]+/i,
  /(?:api[_-]?key|encryptedapikey|master[_-]?key|fingerprint)\s*[:=]\s*[^\s,;]+/i,
  /proxy_set_header\s+x-admin-token\s+"(?!\[?redacted\]?|<redacted>)[^"]{8,}"/i,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----/i
];

function envSecretValues() {
  return Object.entries(process.env)
    .filter(([name, value]) => value && (/_KEY$/i.test(name) || /TOKEN/i.test(name) || /SECRET/i.test(name) || /PASSWORD/i.test(name)))
    .map(([, value]) => value.trim())
    .filter((value) => value.length >= 8);
}

function safeRunnerId() {
  const value = process.env.RUNNER_ID || process.env.CI_RUN_ID || process.env.GITHUB_RUN_ID || process.env.HOSTNAME || hostname();
  return String(value).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 80) || "unknown-runner";
}

export function commitSha() {
  const configured = process.env.GIT_COMMIT_SHA?.trim();
  if (configured) return configured.slice(0, 64);
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().slice(0, 64) || "unknown";
  } catch {
    return "unknown";
  }
}

export function releaseMetadata(environmentLabel = "local") {
  return {
    timestamp: new Date().toISOString(),
    commitSha: commitSha(),
    environmentLabel: String(environmentLabel).replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 80) || "unknown",
    runnerId: safeRunnerId(),
    runnerEnvironment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      ci: process.env.CI === "true"
    }
  };
}

export function artifactPath(name, envName) {
  const configured = envName ? process.env[envName]?.trim() : undefined;
  if (configured) return isAbsolute(configured) ? configured : resolve(root, configured);
  return join(root, "release-artifacts", "phase3a", `${name}.json`);
}

function sanitizeValue(value, key = "") {
  if (SENSITIVE_KEYS.test(key) || SENSITIVE_OBJECT_KEYS.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)]));
  }
  if (typeof value === "string") return redactText(value);
  return value;
}

export function redactText(value) {
  let text = String(value ?? "");
  for (const secret of envSecretValues()) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/sk-[A-Za-z0-9]{16,}/gi, "[REDACTED_KEY]")
    .replace(/AIza[A-Za-z0-9_-]{30,}/g, "[REDACTED_KEY]")
    .replace(/(authorization|x-admin-token|bearer)\s*[:=]\s*[^\s,;]+/gi, "$1: [REDACTED]")
    .replace(/(api[_-]?key|encryptedapikey|master[_-]?key|fingerprint)\s*[:=]\s*[^\s,;]+/gi, "$1: [REDACTED]")
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]");
}

export function scanArtifactText(text) {
  const candidate = String(text ?? "");
  const matchedPattern = SECRET_PATTERNS.find((pattern) => pattern.test(candidate));
  const matchedEnvironmentSecret = envSecretValues().some((secret) => candidate.includes(secret));
  return {
    passed: !matchedPattern && !matchedEnvironmentSecret,
    reason: matchedPattern ? "secret marker detected" : matchedEnvironmentSecret ? "injected secret detected" : undefined
  };
}

export function writeSanitizedArtifact(filePath, payload) {
  const safePayload = sanitizeValue(payload);
  const content = `${JSON.stringify(safePayload, null, 2)}\n`;
  const leakage = scanArtifactText(content);
  if (!leakage.passed) return { written: false, leakage: "FAIL", reason: leakage.reason };

  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, content, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    const afterWrite = scanArtifactText(content);
    if (!afterWrite.passed) return { written: false, leakage: "FAIL", reason: afterWrite.reason };
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
    return { written: true, leakage: "PASS" };
  } finally {
    try { rmSync(temporaryPath, { force: true }); } catch { /* best effort cleanup */ }
  }
}

export function sanitizeDiagnostic(value, maxLength = 240) {
  return redactText(String(value ?? "").replace(/\s+/g, " ")).slice(0, maxLength);
}

export { root };
