import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const browserEntry = resolve(repoRoot, "packages/ai-orchestration/src/browser.ts");
const source = readFileSync(browserEntry, "utf8");
const forbidden = ["node:", "local-qm-adapter", "@yc-software/qm", "better-sqlite3", "process.env"];
const violations = forbidden.filter((token) => source.includes(token));
if (violations.length) {
  console.error(`Browser entry imports forbidden server material: ${violations.join(", ")}`);
  process.exit(1);
}
console.log("[qm-browser-boundary] PASS browser entry is server-free");
