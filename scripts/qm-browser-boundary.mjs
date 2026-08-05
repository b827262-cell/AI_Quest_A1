import { existsSync, readFileSync, readdirSync } from "node:fs";
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

const adminDist = resolve(repoRoot, "apps/AI-adm-D1/dist/assets");
if (existsSync(adminDist)) {
  const bundleForbidden = ["node:child_process", "child_process", "@yc-software/qm", "qm-runner.ts", "process.env"];
  const bundleViolations = [];
  for (const filename of readdirSync(adminDist).filter((name) => name.endsWith(".js"))) {
    const bundle = readFileSync(resolve(adminDist, filename), "utf8");
    for (const token of bundleForbidden) {
      if (bundle.includes(token)) bundleViolations.push(`${filename}:${token}`);
    }
  }
  if (bundleViolations.length) {
    console.error(`Admin browser bundle contains forbidden server material: ${bundleViolations.join(", ")}`);
    process.exit(1);
  }
}
console.log("[qm-browser-boundary] PASS browser entry is server-free");
