import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixtureDir = join(root, "tests", "fixtures", "security");

console.log(`[security-fixtures-validator] Checking directory: ${fixtureDir}`);

const expectedFiles = [
  "roles.json",
  "tokens.json",
  "responses.json",
  "prompt-injections.json",
  "upload-samples.json",
  "ssrf-targets.json",
  "scope-data.json"
];

let errors = 0;
const foundFiles = readdirSync(fixtureDir);

for (const expected of expectedFiles) {
  if (!foundFiles.includes(expected)) {
    console.error(`❌ Missing expected fixture file: ${expected}`);
    errors++;
    continue;
  }

  const filePath = join(fixtureDir, expected);
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    
    // Security check: ensure no real secrets or unredacted keys exist in synthetic fixtures
    const rawStr = JSON.stringify(parsed);
    if (/(?:sk-[a-zA-Z0-9]{20,}|AIzaSy[a-zA-Z0-9_-]{33}|ghp_[a-zA-Z0-9]{36})/.test(rawStr)) {
      console.error(`❌ Security Alert: Unredacted real API key detected in ${expected}`);
      errors++;
    } else {
      console.log(`✅ ${expected} valid JSON (${raw.length} bytes)`);
    }
  } catch (err) {
    console.error(`❌ Invalid JSON in ${expected}: ${err.message}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`\nValidation failed with ${errors} error(s).`);
  process.exitCode = 1;
} else {
  console.log(`\n🎉 All ${expectedFiles.length} synthetic security fixtures successfully validated!`);
}
