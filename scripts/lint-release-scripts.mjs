import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const scriptsDir = join(root, "scripts");
const releaseScriptNames = new Set([
  "admin-navigation-smoke.mjs",
  "admin-provider-ui-e2e.mjs",
  "credential-key-rotation.ts",
  "phase3a-release-gate.mjs",
  "phase3a-staging-smoke.ts",
  "production-verification.mjs",
  "provider-live-smoke.ts",
  "release-artifacts.mjs",
  "release-gate-core.mjs"
]);
const files = readdirSync(scriptsDir).filter((name) => releaseScriptNames.has(name)).sort();
const diagnostics = [];

for (const name of files) {
  const file = join(scriptsDir, name);
  const source = readFileSync(file, "utf8");
  if (/\b(?:describe|it|test|suite|specify)\.(?:only|skip)\s*\(/.test(source)) diagnostics.push(`${name}: skipped or only test found`);
  if (/(?:\b:\s*any\b|\bas\s+any\b|<any>)/.test(source)) diagnostics.push(`${name}: explicit any found`);
  if (/console\.(?:log|warn|error|info|debug)\s*\([^\n]*(?:apiKey|authorization|bearer|encryptedApiKey|masterKey|secret|process\.env)/i.test(source)) diagnostics.push(`${name}: possible sensitive console output`);
  if (/\.then\s*\([^\n]*\);/.test(source) && !/\.catch\s*\(/.test(source)) diagnostics.push(`${name}: uncaught single-line Promise chain found`);
  if (name.endsWith(".mjs")) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) diagnostics.push(`${name}: JavaScript syntax check failed`);
  }
}

if (diagnostics.length) {
  console.error(`release-script lint: ${files.length} scripts checked; ${diagnostics.length} error(s)`);
  for (const diagnostic of diagnostics) console.error(diagnostic);
  process.exitCode = 1;
} else {
  console.log(`release-script lint: ${files.length} scripts checked; 0 error(s), 0 warning(s)`);
}
