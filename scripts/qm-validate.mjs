import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { QM_CLI_VERSION, QM_PACKAGE } from "./qm-version.mjs";

const deploymentDir = resolve(process.env.QM_DEPLOYMENT_DIR ?? "deploy/qm");
const packagePath = resolve(deploymentDir, "package.json");
const configPath = resolve(deploymentDir, "qm.config.jsonc");

if (!existsSync(packagePath) || !existsSync(configPath)) {
  console.error(`QM deployment is incomplete: expected ${packagePath} and ${configPath}`);
  process.exit(2);
}

const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const pinned = packageJson.dependencies?.["@yc-software/qm"];
if (pinned !== QM_CLI_VERSION) {
  console.error(`QM CLI pin mismatch: expected ${QM_CLI_VERSION}, got ${pinned ?? "missing"}`);
  process.exit(2);
}

const boundary = spawnSync(process.execPath, [resolve("scripts/qm-browser-boundary.mjs")], {
  cwd: resolve("."),
  stdio: "inherit",
  env: { ...process.env }
});
if (boundary.error || boundary.status !== 0) {
  console.error("QM validation stopped at the Browser/Server boundary check.");
  process.exit(boundary.status ?? 1);
}

const localBin = resolve(deploymentDir, "node_modules/.bin/qm");
const command = existsSync(localBin) ? localBin : "npm";
const commandArgs = existsSync(localBin)
  ? ["check", "--json"]
  : ["exec", "--yes", `--package=${QM_PACKAGE}`, "--", "qm", "check", "--json"];

console.log(`Validating QM deployment with ${QM_PACKAGE}`);
const result = spawnSync(command, commandArgs, {
  cwd: deploymentDir,
  stdio: "inherit",
  env: { ...process.env }
});
if (result.error) {
  console.error(`Unable to run the pinned QM CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
