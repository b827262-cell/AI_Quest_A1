import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, "..");

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /AIza[0-9A-Za-z-_]{35}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
];

function scanDirectory(dir: string): boolean {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let hasLeak = false;

  for (const entry of entries) {
    if (
      entry.name.startsWith(".git") ||
      entry.name === "node_modules" ||
      entry.name === ".next" ||
      entry.name === ".wrangler" ||
      entry.name === ".vinext" ||
      entry.name === "dist"
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (scanDirectory(fullPath)) hasLeak = true;
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name.endsWith(".js") || entry.name.endsWith(".mjs") || entry.name.endsWith(".json"))) {
      const content = fs.readFileSync(fullPath, "utf-8");
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) {
          console.error(`❌ Potential secret detected in ${fullPath}: pattern ${pattern}`);
          hasLeak = true;
        }
      }
    }
  }

  return hasLeak;
}

function scanSecrets() {
  console.log("🔍 Scanning site source code for secrets...");
  const hasLeak = scanDirectory(ROOT_DIR);
  if (hasLeak) {
    console.error("❌ Secrets Scan: FAIL");
    process.exit(1);
  }
  console.log("✅ Secrets Scan: PASS (0 secrets detected)");
}

scanSecrets();
