import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const testDbPath = join(root, "data", "test-isolated-security.db");
const testDbShm = join(root, "data", "test-isolated-security.db-shm");
const testDbWal = join(root, "data", "test-isolated-security.db-wal");

console.log("=== 🧹 Cleaning up Isolated Security Test Environment ===");

const filesToRemove = [testDbPath, testDbShm, testDbWal];

for (const file of filesToRemove) {
  if (existsSync(file)) {
    try {
      unlinkSync(file);
      console.log(`Removed temporary test database file: ${file}`);
    } catch (err) {
      console.warn(`Could not remove ${file}: ${err.message}`);
    }
  }
}

console.log("✅ Security test environment cleanup finished!");
