import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(process.cwd(), "../..");
const normalizer = join(repoRoot, "scripts/sites-normalize-vite-output.mjs");
const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => rm(project, { recursive: true, force: true })));
});

describe("Sites Vite output normalizer", () => {
  it("normalizes the client/assets layout emitted by the production build", async () => {
    const project = await mkdtemp(join(tmpdir(), "sites-normalizer-"));
    temporaryProjects.push(project);
    const dist = join(project, "dist");
    const workerOutput = join(dist, "ai_quest_a1_admin_sites");
    const assets = join(dist, "client", "assets");

    await mkdir(workerOutput, { recursive: true });
    await mkdir(assets, { recursive: true });
    await writeFile(join(workerOutput, "index.js"), "export default {};\n");
    await writeFile(
      join(workerOutput, "wrangler.json"),
      JSON.stringify({ main: "./index.js", assets: { binding: "ASSETS" }, configPath: "ignored" })
    );
    await writeFile(join(dist, "client", "index.html"), "<!doctype html>\n");
    await writeFile(join(assets, "index.js"), "const dev = `http://localhost`;\n");

    await execFileAsync(process.execPath, [normalizer, project, "ai_quest_a1_admin_sites"]);

    expect(await readFile(join(dist, "server", "index.js"), "utf8")).toContain("export default");
    expect(await readFile(join(dist, "wrangler.json"), "utf8")).toContain('"directory":"./client"');
    expect(await readFile(join(assets, "index.js"), "utf8")).not.toContain("localhost");
  });
});
