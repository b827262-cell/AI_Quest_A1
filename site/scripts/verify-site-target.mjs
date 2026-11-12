#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function extractEmbeddedEnv(distServerDir) {
  let siteRole = null;
  let siteName = null;
  let files = [];
  try {
    files = fs.readdirSync(distServerDir);
  } catch {
    return { siteRole: null, siteName: null };
  }
  const roleRe = /(?:["'])SITE_ROLE["']\s*:\s*["`]([^"`]+)["`]/;
  const nameRe = /(?:["'])SITE_NAME["']\s*:\s*["`]([^"`]+)["`]/;
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    const fullPath = path.join(distServerDir, file);
    let content;
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    const roleMatch = content.match(roleRe);
    const nameMatch = content.match(nameRe);
    if (roleMatch) siteRole = roleMatch[1];
    if (nameMatch) siteName = nameMatch[1];
    if (siteRole && siteName) break;
  }
  return { siteRole, siteName };
}

export function verifySiteTarget(options) {
  const siteTarget = options.siteTarget;
  const targets = options.targets ?? readJson(options.targetsPath ?? path.join(siteDir, "deploy", "targets.json"));
  const hosting = options.hosting ?? readJson(options.hostingPath ?? path.join(siteDir, ".openai", "hosting.json"));
  const distServerDir = options.distServerDir ?? path.join(siteDir, "dist", "server");

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

  const { siteRole, siteName } = extractEmbeddedEnv(distServerDir);

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

function main() {
  const result = verifySiteTarget({ siteTarget: process.env.SITE_TARGET });
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
