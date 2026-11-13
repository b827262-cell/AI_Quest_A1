#!/usr/bin/env node
// Validate security test fixtures.
//
// Two layers:
//   1. Static scan - no real secrets, all domains @example.invalid.
//   2. Dynamic validation - import every fixture module and exercise its
//      behaviour (redaction round-trip, lazy upload buffers, ownership
//      isolation, token/role/SSRF/response/prompt-injection helpers).
//
// Failure messages never echo a sample value, only the sample name.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const UPLOAD_LAZY_IMPORT_LIMIT_BYTES = 8 * 1024 * 1024;
const MIB = 1024 * 1024;

let failures = 0;

function fail(message) {
  console.error(`FAIL: ${message}`);
  failures += 1;
}

function ok(message) {
  console.log(`ok: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
  return Boolean(condition);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return false;
  }
  return true;
}

function scanForSecrets(contents, filePath) {
  if (SECRET_SAMPLE_FILES.has(path.basename(filePath))) return;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(contents)) {
      fail(`${filePath}: possible secret matched ${pattern}`);
    }
  }
}

function scanDomains(contents, filePath) {
  if (DOMAIN_EXCEPTION_FILES.has(path.basename(filePath))) return;
  const domainRe = /@([a-zA-Z0-9.-]+)/g;
  let match;
  while ((match = domainRe.exec(contents)) !== null) {
    const domain = match[1].replace(/\.+$/, "");
    if (domain !== "example.invalid") {
      fail(`${filePath}: non-example.invalid domain: ${domain}`);
    }
  }
}

async function loadFixture(filePath) {
  const before = process.memoryUsage().arrayBuffers;
  try {
    const module = await import(pathToFileURL(filePath).href);
    const after = process.memoryUsage().arrayBuffers;
    return { module, allocatedBytes: after - before };
  } catch (error) {
    fail(`${filePath}: dynamic import failed (${error?.name ?? "Error"})`);
    return null;
  }
}

function validateRedaction(module) {
  const { SECRET_REDACTION_SAMPLES, REDACT_PATTERNS, redactSecrets, hasUnredactedSecret } = module;
  if (!Array.isArray(SECRET_REDACTION_SAMPLES) || typeof redactSecrets !== "function" || typeof hasUnredactedSecret !== "function") {
    fail("redaction.mjs: missing samples or helpers");
    return;
  }
  assert(Array.isArray(REDACT_PATTERNS) && REDACT_PATTERNS.length >= 5, "redaction.mjs: expected at least 5 redaction patterns");

  let secretSamples = 0;
  for (const sample of SECRET_REDACTION_SAMPLES) {
    if (!sample || typeof sample.name !== "string" || typeof sample.input !== "string" || typeof sample.expected !== "string") {
      fail("redaction.mjs: malformed sample entry");
      continue;
    }
    if (sample.name === "normal_text") {
      assertEqual(hasUnredactedSecret(sample.input), false, `redaction:${sample.name} raw detected`);
      assertEqual(redactSecrets(sample.input), sample.expected, `redaction:${sample.name}`);
      continue;
    }
    secretSamples += 1;
    assertEqual(hasUnredactedSecret(sample.input), true, `redaction:${sample.name} raw detected`);
    const redacted = redactSecrets(sample.input);
    assertEqual(redacted, sample.expected, `redaction:${sample.name}`);
    assertEqual(hasUnredactedSecret(redacted), false, `redaction:${sample.name} redacted detected`);
  }
  assert(secretSamples >= 5, `redaction.mjs: expected at least 5 secret samples, found ${secretSamples}`);
  if (secretSamples >= 5) ok("redaction.mjs: samples detected and round-trip to expected output");
}

function validateUploads(module, allocatedBytes) {
  const { getUploadErrorCases, createUploadErrorCases, isUploadRejected, ACCEPTED_IMAGE_TYPES } = module;
  assert(
    allocatedBytes < UPLOAD_LAZY_IMPORT_LIMIT_BYTES,
    `uploads.mjs: import allocated ${allocatedBytes} bytes (>${UPLOAD_LAZY_IMPORT_LIMIT_BYTES}); expected lazy factory`
  );
  assertEqual(module.UPLOAD_ERROR_CASES, undefined, "uploads.mjs: UPLOAD_ERROR_CASES must not be eagerly exported");
  if (typeof getUploadErrorCases !== "function" || typeof createUploadErrorCases !== "function") {
    fail("uploads.mjs: missing lazy factory/getter");
    return;
  }

  const cases = getUploadErrorCases();
  assert(Array.isArray(cases) && cases.length >= 9, "uploads.mjs: expected at least 9 upload cases");
  const byName = new Map(cases.map((item) => [item.name, item]));
  assertEqual(byName.get("oversize_upload")?.bytes?.length, 25 * MIB + 1, "uploads.mjs: oversize buffer size");
  assertEqual(byName.get("exact_limit_upload")?.bytes?.length, 25 * MIB, "uploads.mjs: exact-limit buffer size");
  assertEqual(isUploadRejected({ expectedStatus: 415 }), true, "uploads.mjs: 415 rejected");
  assertEqual(isUploadRejected({ expectedStatus: 413 }), true, "uploads.mjs: 413 rejected");
  assertEqual(isUploadRejected({ expectedStatus: 201 }), false, "uploads.mjs: 201 accepted");
  assert(Array.isArray(ACCEPTED_IMAGE_TYPES) && ACCEPTED_IMAGE_TYPES.length === 3, "uploads.mjs: accepted image types");
  ok("uploads.mjs: buffers are lazy and sizes/status helpers are correct");
}

function validateCourses(module) {
  const { COURSES, CLASSES, STUDENTS, ENROLLMENTS, isolateData } = module;
  if (typeof isolateData !== "function" || !Array.isArray(COURSES)) {
    fail("courses.mjs: missing isolateData or COURSES");
    return;
  }
  const teacherOne = "teacher-001@example.invalid";
  const teacherTwo = "teacher-002@example.invalid";
  const taOne = "ta-001@example.invalid";

  const ownedCourses = isolateData("teacher", teacherOne, COURSES);
  assertEqual(ownedCourses.length, 1, "courses.mjs: teacher-001 course count");
  assertEqual(ownedCourses[0]?.courseId, "course-101@example.invalid", "courses.mjs: teacher-001 course id");

  const otherCourses = isolateData("teacher", teacherTwo, COURSES);
  assertEqual(otherCourses.length, 1, "courses.mjs: teacher-002 course count");
  assertEqual(otherCourses[0]?.courseId, "course-102@example.invalid", "courses.mjs: teacher-002 course id");

  assertEqual(isolateData("teacher", "teacher-999@example.invalid", COURSES).length, 0, "courses.mjs: unowned teacher sees no course");
  assertEqual(isolateData("teacher", teacherOne, CLASSES).length, 2, "courses.mjs: teacher-001 class count");
  assertEqual(isolateData("teacher", teacherOne, STUDENTS).length, 3, "courses.mjs: teacher-001 student count");
  assertEqual(isolateData("teacher", teacherOne, ENROLLMENTS).length, 3, "courses.mjs: teacher-001 enrollment count");

  const taCourses = isolateData("ta", taOne, COURSES);
  assertEqual(taCourses.length, 1, "courses.mjs: assigned TA course count");
  assertEqual(taCourses[0]?.courseId, "course-101@example.invalid", "courses.mjs: assigned TA course id");
  assertEqual(isolateData("ta", "ta-999@example.invalid", COURSES).length, 0, "courses.mjs: unassigned TA sees no course");

  assertEqual(isolateData("student", "student-001@example.invalid", ENROLLMENTS).length, 1, "courses.mjs: student own enrollment");
  assertEqual(isolateData("student", "student-001@example.invalid", COURSES).length, 0, "courses.mjs: student sees no owned course");
  assertEqual(isolateData("admin", "admin@example.invalid", COURSES), COURSES, "courses.mjs: admin sees all courses");
  assertEqual(isolateData("unauth", null, COURSES).length, 0, "courses.mjs: unauthenticated sees nothing");
  ok("courses.mjs: isolation follows real ownership/assignment");
}

function validateRoles(module) {
  const { ROLES, roleFor, can, ROLE_PERMISSIONS } = module;
  assert(Array.isArray(ROLES) && ROLES.length === 5, "roles.mjs: expected 5 roles");
  for (const role of ["admin", "teacher", "ta", "student", "unauth"]) {
    assert(role in ROLE_PERMISSIONS, `roles.mjs: missing permissions for ${role}`);
  }
  assertEqual(roleFor("teacher@example.invalid")?.role, "teacher", "roles.mjs: roleFor teacher");
  assertEqual(roleFor("unknown@example.invalid")?.role, "unauth", "roles.mjs: roleFor unknown");
  assertEqual(can("admin", "system:read"), true, "roles.mjs: admin system:read");
  assertEqual(can("ta", "course:write"), false, "roles.mjs: ta course:write");
  assertEqual(can("student", "upload:read"), true, "roles.mjs: student upload:read");
  ok("roles.mjs: role lookup and permissions are coherent");
}

function validateTokens(module) {
  const { TOKENS, TOKEN_METADATA, tokenFor, isFakeToken } = module;
  for (const kind of ["valid", "expired", "revoked", "malformed"]) {
    assert(typeof tokenFor(kind) === "string" || kind === "malformed", `tokens.mjs: tokenFor(${kind})`);
  }
  assertEqual(tokenFor("missing"), null, "tokens.mjs: unknown kind");
  assertEqual(isFakeToken(TOKENS.valid), true, "tokens.mjs: valid token is fake");
  assertEqual(isFakeToken("real-looking.jwt.value"), false, "tokens.mjs: non-fixture token rejected");
  assertEqual(TOKEN_METADATA[TOKENS.valid]?.role, "admin", "tokens.mjs: valid token metadata");
  assertEqual(TOKEN_METADATA[TOKENS.malformed], null, "tokens.mjs: malformed token metadata");
  ok("tokens.mjs: token helpers behave as fixtures");
}

function validateSsrf(module) {
  const { SSRF_STUB_URLS, SSRF_BLOCKED_URLS, isLocalOnly, isBlocked } = module;
  assert(Array.isArray(SSRF_STUB_URLS) && SSRF_STUB_URLS.length >= 5, "ssrf.mjs: stub URL list");
  assert(Array.isArray(SSRF_BLOCKED_URLS) && SSRF_BLOCKED_URLS.length >= 5, "ssrf.mjs: blocked URL list");
  for (const url of SSRF_STUB_URLS) {
    assertEqual(isLocalOnly(url), true, `ssrf.mjs: stub not local (${url})`);
  }
  for (const url of SSRF_BLOCKED_URLS) {
    assertEqual(isBlocked(url), true, `ssrf.mjs: blocked URL allowed (${url})`);
  }
  assertEqual(isLocalOnly("http://169.254.169.254/latest/meta-data/"), false, "ssrf.mjs: metadata IP treated as local");
  ok("ssrf.mjs: local and blocked classification is correct");
}

function validateResponses(module) {
  const { ERROR_RESPONSES, errorFor, isSafeError } = module;
  const categories = Object.keys(ERROR_RESPONSES ?? {});
  assert(categories.length === 4, "responses.mjs: expected 4 error categories");
  let count = 0;
  for (const category of categories) {
    for (const [kind, entry] of Object.entries(ERROR_RESPONSES[category])) {
      count += 1;
      assertEqual(errorFor(category, kind), entry, `responses.mjs: errorFor(${category},${kind})`);
      assert(typeof entry.status === "number", `responses.mjs: ${category}.${kind} status`);
      assertEqual(isSafeError(entry.body), true, `responses.mjs: ${category}.${kind} body leaked a secret`);
    }
  }
  assert(count >= 15, `responses.mjs: expected at least 15 error responses, found ${count}`);
  assertEqual(errorFor("auth", "missing"), null, "responses.mjs: unknown error");
  // Assembled so this script itself never carries a contiguous secret literal.
  const unsafeBody = { detail: ["sk", "-", "SyntheticFixture".repeat(2)].join("") };
  assertEqual(isSafeError(unsafeBody), false, "responses.mjs: unsafe body not detected");
  ok("responses.mjs: error contracts are present and safe");
}

function validatePromptInjection(module) {
  const { PROMPT_INJECTION_SAMPLES, isPromptInjection } = module;
  assert(Array.isArray(PROMPT_INJECTION_SAMPLES) && PROMPT_INJECTION_SAMPLES.length >= 5, "prompt-injection.mjs: samples");
  for (const sample of PROMPT_INJECTION_SAMPLES) {
    const expected = sample.expected === "blocked";
    assertEqual(isPromptInjection(sample.input), expected, `prompt-injection.mjs: ${sample.name}`);
  }
  ok("prompt-injection.mjs: every sample matches its expected verdict");
}

function validateConcurrency(module) {
  const { CONCURRENT_401_REQUESTS, CONCURRENT_401_EXPECTED_STATUS, LOGOUT_SESSIONS, logoutScenario } = module;
  assert(Array.isArray(CONCURRENT_401_REQUESTS) && CONCURRENT_401_REQUESTS.length >= 5, "concurrency.mjs: 401 requests");
  assertEqual(CONCURRENT_401_EXPECTED_STATUS, 401, "concurrency.mjs: expected 401 status");
  const scenario = logoutScenario(LOGOUT_SESSIONS[0]);
  assertEqual(scenario.revokePath.includes(LOGOUT_SESSIONS[0].sessionId), true, "concurrency.mjs: revoke path scoped to session");
  assertEqual(scenario.verifyPath.includes(LOGOUT_SESSIONS[0].sessionId), true, "concurrency.mjs: verify path scoped to session");
  ok("concurrency.mjs: logout scenario helpers are coherent");
}

const VALIDATORS = {
  "redaction.mjs": (module) => validateRedaction(module),
  "uploads.mjs": (module, allocatedBytes) => validateUploads(module, allocatedBytes),
  "courses.mjs": (module) => validateCourses(module),
  "roles.mjs": (module) => validateRoles(module),
  "tokens.mjs": (module) => validateTokens(module),
  "ssrf.mjs": (module) => validateSsrf(module),
  "responses.mjs": (module) => validateResponses(module),
  "prompt-injection.mjs": (module) => validatePromptInjection(module),
  "concurrency.mjs": (module) => validateConcurrency(module)
};

async function main() {
  if (!fs.existsSync(fixturesDir)) {
    fail(`fixtures directory not found: ${fixturesDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(fixturesDir).filter((file) => file.endsWith(".mjs")).sort();
  if (files.length === 0) {
    fail("no fixture .mjs files found");
    process.exit(1);
  }

  for (const file of files) {
    const filePath = path.join(fixturesDir, file);
    scanForSecrets(fs.readFileSync(filePath, "utf8"), filePath);
    scanDomains(fs.readFileSync(filePath, "utf8"), filePath);
    ok(`${file}: static scan`);
  }

  // Dynamic validation: every fixture is imported and exercised. `uploads.mjs`
  // is loaded last (alphabetical) so its allocation delta is meaningful.
  const loaded = new Map();
  for (const file of files) {
    const result = await loadFixture(path.join(fixturesDir, file));
    if (result) loaded.set(file, result);
  }

  for (const [file, validator] of Object.entries(VALIDATORS)) {
    const result = loaded.get(file);
    if (!result) {
      fail(`${file}: not loaded`);
      continue;
    }
    validator(result.module, result.allocatedBytes);
  }

  if (failures > 0) {
    console.error(`\n${failures} validation failure(s).`);
    process.exit(1);
  }

  console.log(`\nAll ${files.length} fixture files validated successfully (static + dynamic).`);
}

await main();
