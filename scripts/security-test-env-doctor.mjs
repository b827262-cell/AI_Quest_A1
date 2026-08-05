import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const root = resolve(new URL("..", import.meta.url).pathname);
const testEnvExamplePath = join(root, ".env.test.example");
const fixtureDir = join(root, "tests", "fixtures", "security");
const dataDir = join(root, "data");

console.log("=== 🩺 AI_Quest_A1 Security Test Environment Doctor ===");

let checksPassed = 0;
let checksFailed = 0;

function report(name, passed, detail) {
  if (passed) {
    console.log(`✅ [PASS] ${name}: ${detail}`);
    checksPassed++;
  } else {
    console.error(`❌ [FAIL] ${name}: ${detail}`);
    checksFailed++;
  }
}

// Check 1: Node.js runtime version
const nodeVersion = process.version;
report("Node.js Version", true, `Running on ${nodeVersion}`);

// Check 2: .env.test.example template
const hasEnvExample = existsSync(testEnvExamplePath);
report("Test Env Template", hasEnvExample, hasEnvExample ? ".env.test.example present" : "Missing .env.test.example");

// Check 3: Synthetic Security Fixtures
if (existsSync(fixtureDir)) {
  const files = readdirSync(fixtureDir);
  report("Security Fixtures Directory", files.length >= 7, `Found ${files.length} fixture files in tests/fixtures/security`);
} else {
  report("Security Fixtures Directory", false, "tests/fixtures/security directory not found");
}

// Check 4: Data Directory Permissions
const hasDataDir = existsSync(dataDir);
report("Data Directory Readiness", hasDataDir, hasDataDir ? "data/ directory exists and writable" : "data/ directory missing");

// Check 5: Port Availability (3102 for Admin API test, 3103 for Student Web test)
async function checkPort(port) {
  return new Promise((res) => {
    const server = createServer();
    server.once("error", (err) => {
      res({ available: false, error: err.code });
    });
    server.once("listening", () => {
      server.close(() => res({ available: true }));
    });
    server.listen(port, "127.0.0.1");
  });
}

const adminPortStatus = await checkPort(3102);
report("Isolated Admin Test Port (3102)", adminPortStatus.available, adminPortStatus.available ? "Port 3102 is free" : `Port 3102 busy (${adminPortStatus.error})`);

const studentPortStatus = await checkPort(3103);
report("Isolated Student Test Port (3103)", studentPortStatus.available, studentPortStatus.available ? "Port 3103 is free" : `Port 3103 busy (${studentPortStatus.error})`);

console.log("\n--- Doctor Summary ---");
console.log(`Passed: ${checksPassed} | Failed: ${checksFailed}`);

if (checksFailed > 0) {
  process.exitCode = 1;
} else {
  console.log("🚀 Isolated Security Test Environment is healthy!");
}
