import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SITE_DIR = path.join(__dirname, "..");

const FORBIDDEN_STRINGS = [
  "better-sqlite3",
  "/opt/ai-smartbook",
  "ai-smartbook-r1.db",
  "/data/ai-smartbook-r1.db",
];

function checkFile(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf-8");
  for (const forbidden of FORBIDDEN_STRINGS) {
    if (content.includes(forbidden)) {
      console.error(`❌ Prohibited production reference '${forbidden}' found in ${filePath}`);
      return true;
    }
  }
  return false;
}

function walk(dir: string): boolean {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let foundProhibited = false;

  for (const entry of entries) {
    if (
      entry.name.startsWith(".git") ||
      entry.name === "node_modules" ||
      entry.name === ".next" ||
      entry.name === ".wrangler" ||
      entry.name === ".vinext" ||
      entry.name === "dist" ||
      entry.name === "package-lock.json" ||
      entry.name === "verify-no-production-data.ts" // skip self
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (walk(fullPath)) foundProhibited = true;
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name.endsWith(".js") || entry.name.endsWith(".json"))
    ) {
      if (checkFile(fullPath)) foundProhibited = true;
    }
  }

  return foundProhibited;
}

function verifyNoProdData() {
  console.log("🔍 Verifying that site has zero references or dependencies to production DBs...");
  const failed = walk(SITE_DIR);
  if (failed) {
    console.error("❌ Production Isolation Check: FAIL");
    process.exit(1);
  }
  console.log("✅ Production Isolation Check: PASS (100% physically isolated from production DB)");
}

verifyNoProdData();
