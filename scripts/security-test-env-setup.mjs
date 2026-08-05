import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const envExample = join(root, ".env.test.example");
const envTest = join(root, ".env.test");
const testDbPath = join(root, "data", "test-isolated-security.db");

console.log("=== 🛠️ Setting up Isolated Security Test Environment ===");

// Step 1: Ensure .env.test exists
if (!existsSync(envTest)) {
  console.log("Creating .env.test from .env.test.example...");
  copyFileSync(envExample, envTest);
} else {
  console.log("Using existing .env.test");
}

// Step 2: Touch / prepare test DB file
if (!existsSync(testDbPath)) {
  console.log(`Initializing isolated test database at ${testDbPath}...`);
  writeFileSync(testDbPath, "");
} else {
  console.log(`Isolated test database file exists at ${testDbPath}`);
}

// Step 3: Run fixture validation
console.log("Validating synthetic security fixtures...");
const valResult = spawnSync(process.execPath, [join(root, "scripts", "validate-security-fixtures.mjs")], { stdio: "inherit" });
if (valResult.status !== 0) {
  console.error("❌ Fixture validation failed during setup.");
  process.exitCode = 1;
} else {
  console.log("✅ Isolated Security Test Environment Setup Complete!");
  console.log("\nTo run server in isolated test mode:");
  console.log("  PORT=3102 DATABASE_URL=file:./data/test-isolated-security.db pnpm --filter AI-adm-D1 dev");
}
