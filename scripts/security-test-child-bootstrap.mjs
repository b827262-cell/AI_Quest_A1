import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const markerName = ".aiquest-security-test-owner.json";
const tempPrefix = "aiquest-security-test-env-";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markerPath = process.env.SECURITY_TEST_MARKER_PATH;
const runId = process.env.SECURITY_TEST_RUN_ID;
if (!markerPath || !runId || basename(markerPath) !== markerName || !basename(dirname(markerPath)).startsWith(tempPrefix)) {
  throw new Error("security test child bootstrap has invalid ownership metadata");
}
const marker = JSON.parse(readFileSync(markerPath, "utf8"));
if (marker.version !== 1 || marker.repoRoot !== repoRoot || marker.runId !== runId) {
  throw new Error("security test child bootstrap could not verify run ownership");
}
const temporary = `${markerPath}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify({ ...marker, pid: process.pid }), { mode: 0o600, flag: "wx" });
renameSync(temporary, markerPath);
