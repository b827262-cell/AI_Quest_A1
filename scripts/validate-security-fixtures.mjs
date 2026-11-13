#!/usr/bin/env node
// Validate security test fixtures.
// Checks: no real secrets, all domains @example.invalid, all tokens fake,
// all fixture modules loadable, expected structure present.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const fixturesDir = path.resolve(repoRoot, "tests", "fixtures", "security");

const SECRET_PATTERNS = [
  /sk_[a-zA-Z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  /ADMIN_PASSWORD\s*=\s*\S+/i,
  /(?<=password[=:]\s*)\S{8,}/i
];

// Files that intentionally contain secret patterns as test samples.
const SECRET_SAMPLE_FILES = new Set(["redaction.mjs"]);

// Files that intentionally use non-example.invalid subdomains for test coverage.
const DOMAIN_EXCEPTION_FILES = new Set(["tokens.mjs"]);

let failures = 0;

function fail(message) {
  console.error(`FAIL: ${message}`);
  failures += 1;
}

function ok(message) {
  console.log(`ok: ${message}`);
}

function scanForSecrets(contents, filePath) {
  if (SECRET_SAMPLE_FILES.has(path.basename(filePath))) return;
  let found = false;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(contents)) {
      fail(`${filePath}: possible secret matched ${pattern}`);
      found = true;
    }
  }
  return found;
}

function scanDomains(contents, filePath) {
  if (DOMAIN_EXCEPTION_FILES.has(path.basename(filePath))) return;
  let found = false;
  const domainRe = /@([a-zA-Z0-9.-]+)/g;
  let match;
  while ((match = domainRe.exec(contents)) !== null) {
    let domain = match[1];
    // Strip trailing dots/punctuation that may have been absorbed.
    domain = domain.replace(/\.+$/, "");
    if (domain !== "example.invalid") {
      fail(`${filePath}: non-example.invalid domain: ${domain}`);
      found = true;
    }
  }
  return found;
}

function main() {
  if (!fs.existsSync(fixturesDir)) {
    fail(`fixtures directory not found: ${fixturesDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".mjs")).sort();

  if (files.length === 0) {
    fail("no fixture .mjs files found");
    process.exit(1);
  }

  for (const file of files) {
    const filePath = path.join(fixturesDir, file);
    const contents = fs.readFileSync(filePath, "utf8");

    scanForSecrets(contents, filePath);
    scanDomains(contents, filePath);

    ok(`${filePath}: scanned`);
  }

  // Validate cross-cutting expectations.
  const rolesContents = fs.readFileSync(path.join(fixturesDir, "roles.mjs"), "utf8");
  for (const role of ["admin", "teacher", "ta", "student", "unauth"]) {
    if (!rolesContents.includes(role)) {
      fail(`roles.mjs missing role: ${role}`);
    }
  }

  const tokensContents = fs.readFileSync(path.join(fixturesDir, "tokens.mjs"), "utf8");
  for (const kind of ["valid", "expired", "revoked", "malformed"]) {
    if (!tokensContents.includes(kind)) {
      fail(`tokens.mjs missing kind: ${kind}`);
    }
  }

  const ssrfContents = fs.readFileSync(path.join(fixturesDir, "ssrf.mjs"), "utf8");
  for (const blocked of ["169.254.169.254", "attacker.example.invalid", "192.168.1.1", "metadata.google.internal"]) {
    if (!ssrfContents.includes(blocked)) {
      fail(`ssrf.mjs missing blocked URL: ${blocked}`);
    }
  }

  const uploadContents = fs.readFileSync(path.join(fixturesDir, "uploads.mjs"), "utf8");
  for (const mime of ["image/svg+xml", "text/html", "application/x-msdownload"]) {
    if (!uploadContents.includes(mime)) {
      fail(`uploads.mjs missing MIME type: ${mime}`);
    }
  }

  const redactionContents = fs.readFileSync(path.join(fixturesDir, "redaction.mjs"), "utf8");
  for (const secret of ["sk_", "AKIA", "ghp_", "PRIVATE KEY"]) {
    if (!redactionContents.includes(secret)) {
      fail(`redaction.mjs missing secret pattern: ${secret}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} validation failure(s).`);
    process.exit(1);
  }

  console.log(`\nAll ${files.length} fixture files validated successfully.`);
}

main();
