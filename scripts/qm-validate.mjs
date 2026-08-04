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
if (!existsSync(localBin)) {
  console.error(`QM ${QM_PACKAGE} is not installed in ${deploymentDir}; refusing an npm-exec fallback.`);
  process.exit(2);
}
const currentMajor = Number(process.versions.node.split(".")[0] ?? 0);
const useNode24Wrapper = currentMajor < 24;
const command = useNode24Wrapper ? "npx" : localBin;
const checkArgs = useNode24Wrapper
  ? ["--yes", "--package=node@24", "--", localBin, "check", "--json"]
  : ["check", "--json"];

console.log(`Validating QM deployment with ${QM_PACKAGE}`);
const result = spawnSync(command, checkArgs, {
  cwd: deploymentDir,
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
  env: { ...process.env }
});
if (result.error) {
  console.error("Unable to run the pinned QM CLI: process failure");
}

let contractPass = false;
try {
  const parsed = JSON.parse(`${result.stdout ?? ""}`.trim());
  contractPass = result.status === 0 && parsed?.valid === true;
} catch {
  contractPass = false;
}

const doctorArgs = useNode24Wrapper
  ? ["--yes", "--package=node@24", "--", localBin, "doctor"]
  : ["doctor"];

const doctor = spawnSync(command, doctorArgs, {
  cwd: deploymentDir,
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
  env: { ...process.env }
});

const doctorOutput = `${doctor.stdout ?? ""}\n${doctor.stderr ?? ""}`;
const doctorEnvironmentBlocked = doctor.status !== 0 && /(?:missing|placeholder|not installed|not found|required secret|configuration)/i.test(doctorOutput);
const doctorLabel = doctor.status === 0
  ? "PASS"
  : doctorEnvironmentBlocked
    ? "ENVIRONMENT BLOCKED"
    : "FAIL";
const overallExit = result.status === 0 && doctor.status === 0 ? 0 : 1;

console.log(`Contract ${contractPass ? "PASS" : "FAIL"}`);
console.log(`Doctor ${doctorLabel}`);
console.log(`Overall exit ${overallExit}`);
console.log("Deployment attempted No");
console.log("Real credentials used No");
process.exit(overallExit);
