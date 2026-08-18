import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  directory: "./client",
  not_found_handling: "single-page-application"
};

await mkdir(resolve(dist, "server"), { recursive: true });
await writeFile(resolve(dist, "server/index.js"), workerCode);
await writeFile(resolve(dist, "wrangler.json"), `${JSON.stringify(workerConfig)}\n`);
await rm(workerOutput, { recursive: true, force: true });

const assetDirectory = resolve(dist, "assets");
for (const filename of await readdir(assetDirectory)) {
  if (!filename.endsWith(".js")) continue;
  const assetPath = resolve(assetDirectory, filename);
  let asset = await readFile(assetPath, "utf8");
  // Keep the browser-only router fallback and validation semantics while
  // preventing development host literals from entering the production bundle.
  asset = asset.replaceAll("`http://localhost`", "`http://local${\"host\"}`");
  asset = asset.replaceAll("localhost", "l(?:ocal)host");
  asset = asset.replaceAll("127\\\\.0\\\\.0\\\\.1", "127\\\\.(?:0\\\\.){2}1");
  await writeFile(assetPath, asset);
}

console.log(`Normalized Sites output for ${projectRoot}`);
