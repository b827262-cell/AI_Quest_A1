import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveSiteBuildEnv } from "../scripts/site-build-env.ts";

const SHA = "1111111111111111111111111111111111111111";
const targets = JSON.parse(readFileSync(new URL("../deploy/targets.json", import.meta.url), "utf8")).targets;

test("build inputs reject invalid targets, SHA and origins", () => {
  assert.equal(resolveSiteBuildEnv(undefined, undefined), null);
  for (const target of ["", "other"]) assert.throws(() => resolveSiteBuildEnv(target, SHA));
  for (const sha of [undefined, "bad", "a".repeat(39)]) assert.throws(() => resolveSiteBuildEnv("student", sha));
  for (const origin of ["http://example.test", "https://example.test/path", "https://user@example.test", "not-a-url", null]) {
    const copy = structuredClone(targets);
    copy.student.primary_origin = origin;
    assert.throws(() => resolveSiteBuildEnv("student", SHA, copy));
  }
});

function verifyBuildArtifacts(directory) {
  const secrets = [/sk-[a-zA-Z0-9]{20,}/, /AIza[0-9A-Za-z_-]{35}/, /ghp_[a-zA-Z0-9]{36}/, /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) verifyBuildArtifacts(path);
    else if (entry.isFile()) {
      assert.ok(!path.endsWith(".map"), `unexpected source map ${path}`);
      const content = readFileSync(path, "utf8");
      for (const pattern of secrets) assert.ok(!pattern.test(content), `secret-like material in ${path}`);
    }
  }
}

async function checkHealthServer(expected) {
  const proc = spawn(process.execPath, ["scripts/local-qa-server.mjs"], { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("local QA server timed out")), 10_000);
      proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`local QA server exited: ${code}`)); });
      proc.stdout.on("data", (chunk) => {
        if (String(chunk).includes("[QA SERVER]")) { clearTimeout(timer); resolve(); }
      });
    });
    const response = await fetch("http://127.0.0.1:3002/api/health");
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const [key, value] of Object.entries(expected)) assert.equal(body[key], value, key);
  } finally {
    if (proc.exitCode === null) { proc.kill("SIGTERM"); await new Promise((resolve) => proc.once("exit", resolve)); }
  }
}

test("site builds expose only the chosen topology and honor runtime overrides", async () => {
  const cases = [
    [undefined, { role: "standalone", site: null, primaryOrigin: null, gitSha: "unknown" }],
    ["backend", { role: "primary", site: "backend", primaryOrigin: null, gitSha: SHA }],
    ["student", { role: "secondary", site: "student", primaryOrigin: targets.student.primary_origin, gitSha: SHA }],
    ["admin", { role: "secondary", site: "admin", primaryOrigin: targets.admin.primary_origin, gitSha: SHA }]
  ];
  try {
    for (const [target, expected] of cases) {
    const env = { ...process.env, GIT_SHA: SHA };
    if (target === undefined) delete env.SITE_TARGET; else env.SITE_TARGET = target;
    execFileSync("npm", ["run", "build"], { cwd: process.cwd(), env, stdio: "pipe" });
    verifyBuildArtifacts("dist");
    await checkHealthServer(expected);
    if (target === "student") {
      const script = `
        const {default: worker}=await import('./dist/server/index.js');
        const ctx={waitUntil(){},passThroughOnException(){}};
        const check=async (env)=>{const r=await worker.fetch(new Request('http://127.0.0.1/api/health'),env,ctx);return r.json()};
        const a=await check({SITE_ROLE:'primary',SITE_NAME:'backend',GIT_SHA:'2222222222222222222222222222222222222222'});
        const b=await check({});
        const c=await check({SITE_ROLE:'secondary',SITE_NAME:'student',PRIMARY_ORIGIN:'http://bad.example',GIT_SHA:'invalid'});
        console.log(JSON.stringify([a.role,a.site,a.gitSha,b.role,b.site,b.gitSha,c.primaryOrigin,c.gitSha]));`;
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8" });
      const result = JSON.parse(output.trim().split("\n").at(-1));
      assert.deepEqual(result, ["primary", "backend", "2222222222222222222222222222222222222222", "secondary", "student", SHA, null, "unknown"]);
    }
      console.log(`site build ${target ?? "standalone"}: ${JSON.stringify(expected)}`);
    }
  } finally {
    // Other suites consume dist too; always restore the default standalone build.
    const env = { ...process.env };
    delete env.SITE_TARGET;
    delete env.GIT_SHA;
    execFileSync("npm", ["run", "build"], { cwd: process.cwd(), env, stdio: "pipe" });
  }
});
