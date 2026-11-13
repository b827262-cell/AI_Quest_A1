import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(resolve(scriptDir, ".."));
const markerName = ".aiquest-security-test-owner.json";
const tempPrefix = "aiquest-security-test-env-";
const studentServer = join(repoRoot, "apps/AI-Stu-R1/server/stu-api.ts");
const tsxLoader = join(repoRoot, "apps/AI-adm-D1/node_modules/tsx/dist/loader.mjs");
const studentAppRequire = createRequire(join(repoRoot, "apps/AI-Stu-R1/package.json"));
const Database = studentAppRequire("better-sqlite3");
const { repoRoot: harnessRepoRoot, seedThrowawayStudentDb, rawHttpRequest, createSmokeBrowser, loginViaSmokeAccess, completeSmokeProfile } = await import("./student-smoke-harness.ts");
const { startFakeAccessCerts } = await import("./student-access-fixture.ts");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeMarker(dir, metadata) {
  const target = join(dir, markerName);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, repoRoot, ...metadata }), { mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
}

function markerFor(dir) {
  const path = join(dir, markerName);
  if (!existsSync(path)) return null;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    if (marker.version !== 1 || marker.repoRoot !== repoRoot || typeof marker.runId !== "string") return null;
    return marker;
  } catch {
    return null;
  }
}

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function processCommandLine(pid) {
  try {
    if (process.platform === "linux") return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
    return result.status === 0 ? result.stdout : "";
  } catch { return ""; }
}

function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

async function stopPid(pid, runId) {
  if (!Number.isInteger(pid) || pid <= 1 || !pidIsAlive(pid)) return;
  const commandLine = processCommandLine(pid);
  if (!commandLine.includes(studentServer) || !commandLine.includes(`--security-test-run-id=${runId}`)) {
    throw new Error("refusing to signal a process that does not match this test run");
  }
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 40 && pidIsAlive(pid); attempt++) await delay(100);
  if (pidIsAlive(pid)) process.kill(pid, "SIGKILL");
  for (let attempt = 0; attempt < 30 && pidIsAlive(pid); attempt++) await delay(100);
  if (pidIsAlive(pid)) throw new Error("owned test process did not stop");
}

async function cleanDirectory(dir, marker) {
  if (marker.pid) await stopPid(marker.pid, marker.runId);
  rmSync(dir, { recursive: true, force: true });
  if (existsSync(dir)) throw new Error("test directory cleanup did not complete");
}

async function cleanup() {
  const base = tmpdir();
  const removed = [];
  for (const name of readdirSync(base)) {
    if (!name.startsWith(tempPrefix)) continue;
    const dir = join(base, name);
    let info;
    try { info = statSync(dir); } catch { continue; }
    if (!info.isDirectory()) continue;
    const marker = markerFor(dir);
    if (!marker) continue;
    await cleanDirectory(dir, marker);
    removed.push(name);
  }
  console.log(`security-test cleanup PASS (${removed.length} owned run(s) removed)`);
}

async function getEphemeralPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "could not reserve loopback port");
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function waitForReady(baseUrl, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("student API exited before becoming ready");
    try {
      const response = await rawHttpRequest(new URL("/health/ready", baseUrl));
      if (response.status === 200) return;
      if (response.status >= 500) throw new Error("student API readiness returned an error");
    } catch (error) {
      if (error instanceof Error && error.message === "student API readiness returned an error") throw error;
    }
    await delay(100);
  }
  throw new Error("student API did not become ready within 20 seconds");
}

async function setup() {
  assert(harnessRepoRoot === repoRoot, "smoke harness resolved a different repository root");
  const runId = randomUUID();
  const dir = join(tmpdir(), `${tempPrefix}${runId}`);
  mkdirSync(dir, { mode: 0o700 });
  let child = null;
  let certs = null;
  let pid = null;
  const marker = { runId, pid: null };
  writeMarker(dir, marker);
  try {
    const studentDbPath = join(dir, "student.db");
    const authDbPath = join(dir, "student-auth.db");
    seedThrowawayStudentDb(studentDbPath);
    certs = await startFakeAccessCerts();
    const port = await getEphemeralPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const allowedEnvironment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NODE_ENV: "test",
      TZ: "UTC",
      LANG: "C.UTF-8",
      TMPDIR: dir,
      TEMP: dir,
      TMP: dir,
      STU_RUNTIME_MODE: "sqlite-api",
      STU_DB_PATH: studentDbPath,
      STU_API_PORT: String(port),
      STU_PUBLIC_DIR: join(repoRoot, "apps/AI-Stu-R1/dist"),
      STU_UPLOAD_DIR: join(dir, "uploads"),
      STUDENT_AUTH_DB_PATH: authDbPath,
      STUDENT_SESSION_SECRET: randomBytes(48).toString("base64url"),
      STUDENT_SESSION_TTL_MS: "3600000",
      STUDENT_ALLOWED_ORIGINS: baseUrl,
      STUDENT_GOOGLE_AUTH_ENABLED: "false",
      STUDENT_ACCESS_TEAM_DOMAIN: certs.teamDomain,
      STUDENT_ACCESS_AUD: certs.aud,
      STUDENT_ACCESS_CERTS_URL: certs.certsUrl,
      STUDENT_RAG_PROVIDER: "fake",
      STUDENT_RAG_FAKE_MODE: "grounded",
      SECURITY_TEST_RUN_ID: runId,
      SECURITY_TEST_MARKER_PATH: join(dir, markerName)
    };
    child = spawn(process.execPath, [
      "--import", join(scriptDir, "security-test-child-bootstrap.mjs"),
      "--import", join(scriptDir, "security-test-loopback-guard.mjs"),
      "--import", tsxLoader,
      studentServer,
      `--security-test-run-id=${runId}`
    ], {
      cwd: join(repoRoot, "apps/AI-Stu-R1"),
      env: allowedEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    pid = child.pid ?? null;
    marker.pid = pid;
    writeMarker(dir, marker);
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    await waitForReady(baseUrl, child);

    const live = await rawHttpRequest(new URL("/health/live", baseUrl));
    assert(live.status === 200, "liveness check failed");
    const browser = createSmokeBrowser(baseUrl, baseUrl);
    const anonymous = await browser.request("/api/student/books/book-alpha/rag-ask", { method: "POST", body: { query: "光合作用" } });
    assert(anonymous.status === 401, "anonymous RAG request did not fail closed");
    try {
      await loginViaSmokeAccess(browser, certs.assertion());
    } catch {
      throw new Error(`synthetic Access login failed (local certificate stub requests=${certs.requestCount()})`);
    }
    await completeSmokeProfile(browser, "Synthetic Security Test Student");
    const booksResponse = await browser.request("/api/student/books");
    assert(booksResponse.status === 200, `throwaway SQLite books endpoint returned HTTP ${booksResponse.status}`);
    const books = JSON.parse(booksResponse.bodyText);
    assert(books.books?.map((book) => book.id).sort().join(",") === "book-alpha,book-beta", "deterministic seed did not load");
    const rag = await browser.request("/api/student/books/book-alpha/rag-ask", {
      method: "POST", body: { query: "光合作用如何運作？" }
    });
    assert(rag.status === 200, "local fake-provider request failed");
    const ragBody = JSON.parse(rag.bodyText);
    assert(ragBody.grounding === "verified" && ragBody.citations?.length > 0, "fake-provider response was not grounded");
    assert(certs.requestCount() > 0, "local Access certificate URL stub was not used");

    console.log("security-test setup PASS (loopback-only API, ephemeral SQLite, synthetic Access and fake RAG; 12 checks)");
  } finally {
    let cleanupFailure = null;
    try {
      const childAlive = () => Boolean(child?.pid && pidIsAlive(child.pid));
      if (childAlive()) {
        child.kill("SIGTERM");
        await Promise.race([new Promise((resolvePromise) => child.once("exit", resolvePromise)), delay(3_000)]);
        if (childAlive()) {
          child.kill("SIGKILL");
          await Promise.race([new Promise((resolvePromise) => child.once("exit", resolvePromise)), delay(3_000)]);
        }
      }
      if (childAlive()) throw new Error("student API process did not stop; test data retained for safe cleanup");
    } catch (error) {
      cleanupFailure = error;
    }
    try { if (certs) await certs.close(); } catch (error) { cleanupFailure ??= error; }
    if (!cleanupFailure) {
      rmSync(dir, { recursive: true, force: true });
      if (existsSync(dir)) cleanupFailure = new Error("temporary test directory remained after cleanup");
    }
    if (cleanupFailure) throw new Error(cleanupFailure instanceof Error ? cleanupFailure.message : "cleanup failed");
  }
}

async function doctor() {
  assert(Number(process.versions.node.split(".")[0]) >= 22, "Node.js 22 or newer is required");
  assert(existsSync(tsxLoader) && existsSync(studentServer), "student smoke runtime files are missing; install workspace dependencies first");
  const probe = join(tmpdir(), `${tempPrefix}doctor-${randomUUID()}`);
  mkdirSync(probe, { mode: 0o700 });
  try {
    const dbPath = join(probe, "doctor.db");
    seedThrowawayStudentDb(dbPath);
    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) AS count FROM books").get().count;
    db.close();
    assert(count === 2, "deterministic SQLite fixture probe failed");
    const port = await getEphemeralPort();
    assert(port > 0, "loopback ephemeral port probe failed");
    console.log("security-test doctor PASS (runtime, native SQLite, deterministic fixture, writable temp dir, loopback port)");
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const command = process.argv[2];
try {
  if (command === "doctor") await doctor();
  else if (command === "setup") await setup();
  else if (command === "cleanup") await cleanup();
  else throw new Error("usage: security-test-environment.mjs <doctor|setup|cleanup>");
} catch (error) {
  console.error(`security-test ${command ?? "command"} FAIL: ${error instanceof Error ? error.message : "unexpected error"}`);
  process.exitCode = 1;
}
