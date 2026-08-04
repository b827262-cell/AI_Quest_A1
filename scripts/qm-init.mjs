import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { QM_PACKAGE } from "./qm-version.mjs";

const allowedTargets = new Set(["docker", "fly", "aws"]);
const args = process.argv.slice(2);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: pnpm qm:init -- --dir <empty-dir> --org <slug> --target <docker|fly|aws> [--model-provider <provider>]");
  process.exit(0);
}

const target = valueAfter("--target");
if (!target || !allowedTargets.has(target)) {
  console.error("qm:init requires --target docker, --target fly, or --target aws; no target is guessed.");
  process.exit(2);
}

const org = valueAfter("--org") ?? "ai-quest-a1";
const dir = resolve(valueAfter("--dir") ?? "deploy/qm");
if (existsSync(resolve(dir, "qm.config.jsonc"))) {
  console.error(`Refusing to overwrite an existing QM deployment: ${dir}`);
  console.error("Use qm:validate for the checked-in deployment or choose an empty --dir.");
  process.exit(2);
}

const cliArgs = [
  "exec",
  "--yes",
  `--package=${QM_PACKAGE}`,
  "--",
  "qm",
  "init",
  dir,
  "--org",
  org,
  "--target",
  target
];
const modelProvider = valueAfter("--model-provider");
if (modelProvider) cliArgs.push("--model-provider", modelProvider);

console.log(`Running official QM CLI ${QM_PACKAGE} in ${dir}`);
execFileSync("npm", cliArgs, { stdio: "inherit" });
