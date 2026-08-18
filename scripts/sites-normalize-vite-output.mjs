import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [projectRoot, workerDirectory] = process.argv.slice(2);

if (!projectRoot || !workerDirectory) {
  throw new Error("Usage: sites-normalize-vite-output.mjs <project-root> <worker-directory>");
}

const dist = resolve(projectRoot, "dist");
const workerOutput = resolve(dist, workerDirectory);
const workerSource = resolve(workerOutput, "index.js");
const workerConfigSource = resolve(workerOutput, "wrangler.json");

const workerCode = await readFile(workerSource, "utf8");
const workerConfig = JSON.parse(await readFile(workerConfigSource, "utf8"));
delete workerConfig.configPath;
delete workerConfig.userConfigPath;
delete workerConfig.dev;
workerConfig.main = "./server/index.js";
workerConfig.assets = {
  ...(workerConfig.assets ?? {}),
  directory: ".",
  not_found_handling: "single-page-application"
};

await mkdir(resolve(dist, "server"), { recursive: true });
await writeFile(resolve(dist, "server/index.js"), workerCode);
await writeFile(resolve(dist, "wrangler.json"), `${JSON.stringify(workerConfig)}\n`);
await rm(workerOutput, { recursive: true, force: true });
await rm(resolve(dist, "client"), { recursive: true, force: true });

console.log(`Normalized Sites output for ${projectRoot}`);
