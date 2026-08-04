import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const browserEntry = resolve("packages/ai-orchestration/src/browser.ts");
const source = readFileSync(browserEntry, "utf8");
const forbidden = ["node:", "local-qm-adapter", "@yc-software/qm", "better-sqlite3", "process.env"];
const violations = forbidden.filter((token) => source.includes(token));
if (violations.length) {
  console.error(`Browser entry imports forbidden server material: ${violations.join(", ")}`);
  process.exit(1);
}
console.log("[qm-browser-boundary] PASS browser entry is server-free");
