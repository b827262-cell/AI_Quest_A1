#!/usr/bin/env node

/**
 * Emits the predeploy staging source-of-truth from the checked-in Sites
 * declaration. It performs no network I/O and deliberately records no live
 * health result: the test site has not been deployed yet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostingPath = path.join(siteDir, ".openai/hosting.json");
const capturedAt = process.argv[2] ?? new Date().toISOString();
const hosting = JSON.parse(fs.readFileSync(hostingPath, "utf8"));

if (!/^appgprj_[a-z0-9]+$/i.test(hosting.project_id ?? "")) throw new Error("hosting project_id is not a Sites project identifier");
if ("d1" in hosting || "r2" in hosting) throw new Error("staging hosting declaration must not contain D1/R2 bindings");

console.log(JSON.stringify({
  manifest_version: "phase4a.environment-source-of-truth/v1",
  environment: "staging",
  captured_at: capturedAt,
  capture: { method: "site/scripts/capture-staging-environment.mjs", source: "site/.openai/hosting.json", network_io: false },
  sites: { test_site: { project_id: hosting.project_id, url: "https://ai-quest-a1-qwen3-test.b827262.chatgpt.site" } },
  backend_mode: "isolated-fail-closed",
  postdeploy_live: "PENDING",
}, null, 2));
