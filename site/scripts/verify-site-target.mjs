#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(scriptDir, "..");

const VALID_TARGETS = ["backend", "student", "admin"];

export { VALID_TARGETS };

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(`cannot read ${filePath}: ${err.message}`);
  }
}

register("./cloudflare-workers-hooks.mjs", import.meta.url);

export async function readEmbeddedRoleSite() {
  const workerUrl = new URL(`../dist/server/index.js`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const res = await worker.fetch(new Request("https://preflight.invalid/api/health"), {}, ctx);
  if (!res.ok) {
    fail(`worker /api/health returned ${res.status}`);
  }
  const body = await res.json();
  return { siteRole: body.role ?? null, siteName: body.site ?? null };
}

export async function verifySiteTarget(options) {
  const siteTarget = options.siteTarget;
  const targets = options.targets ?? readJson(options.targetsPath ?? path.join(siteDir, "deploy", "targets.json"));
  const hosting = options.hosting ?? readJson(options.hostingPath ?? path.join(siteDir, ".openai", "hosting.json"));

  const errors = [];

  if (!siteTarget) {
    errors.push("SITE_TARGET is required");
    return { ok: false, errors, projectId: hosting.project_id, site: null };
  }
  if (!VALID_TARGETS.includes(siteTarget)) {
    errors.push(`invalid SITE_TARGET: ${siteTarget}`);
    return { ok: false, errors, projectId: hosting.project_id, site: null };
  }

  const targetConfig = targets.targets?.[siteTarget];
  if (!targetConfig) {
    errors.push(`no target config for ${siteTarget}`);
    return { ok: false, errors, projectId: hosting.project_id, site: null };
  }

  const { siteRole, siteName } = await readEmbeddedRoleSite();

  const projectId = hosting.project_id;
  const expectedProjectId = targetConfig.project_id;

  if (siteRole !== targetConfig.role || siteName !== targetConfig.site) {
    errors.push(`role/site mismatch for ${siteTarget}: dist ${siteRole}/${siteName}, expected ${targetConfig.role}/${targetConfig.site}`);
  }

  if (projectId !== expectedProjectId) {
    errors.push(`project_id mismatch for ${siteTarget}: hosting ${projectId}, expected ${expectedProjectId}`);
  }

  return { ok: errors.length === 0, errors, projectId, site: siteName };
}

async function main() {
  const result = await verifySiteTarget({ siteTarget: process.env.SITE_TARGET });
  if (!result.ok) {
    for (const err of result.errors) {
      console.error(err);
    }
    process.exit(1);
  }
  console.log(`ok: ${process.env.SITE_TARGET} project_id=${result.projectId} site=${result.site}`);
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main();
}
