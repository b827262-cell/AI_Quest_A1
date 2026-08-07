import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Browser, ConsoleMessage, Page } from "playwright-core";
import {
  GateReport,
  createThrowawayDir,
  repoRoot,
  seedThrowawayStudentDb,
  startFakeGoogleProvider,
  startStudentApi
} from "./student-smoke-harness";

/**
 * student:dashboard-smoke — REAL browser gate.
 *
 * Boots the real student API (server/stu-api.ts) serving the built SPA from
 * apps/AI-Stu-R1/dist against throwaway SQLite databases, plus a
 * deterministic Google OAuth fixture provider whose /authorize endpoint
 * auto-approves. Chromium then exercises the full login → profile
 * completion → dashboard → books flow at desktop/tablet/mobile viewports.
 */

const CHROMIUM_PATH =
  process.env.STUDENT_SMOKE_CHROMIUM ??
  join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 1024, height: 768 },
  { name: "mobile", width: 390, height: 844 }
] as const;

const artifactsDir = join(repoRoot, "release-artifacts/student-rag");

const studentAppRequire = createRequire(join(repoRoot, "apps/AI-Stu-R1/package.json"));

function ensureStudentBundle(): void {
  const distEntry = join(repoRoot, "apps/AI-Stu-R1/dist/index.html");
  if (existsSync(distEntry)) return;
  console.log("  … dist missing, building student bundle");
  const build = spawnSync("pnpm", ["--filter", "AI-Stu-R1", "build"], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (build.status !== 0 || !existsSync(distEntry)) {
    throw new Error("student bundle build failed");
  }
}

function expireAllSessions(authDbPath: string): void {
  const Database = studentAppRequire("better-sqlite3") as typeof import("better-sqlite3");
  const db = new Database(authDbPath);
  db.pragma("busy_timeout = 3000");
  db.prepare("UPDATE student_sessions SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
  db.close();
}

interface ConsoleLog {
  viewport: string;
  phase: string;
  type: string;
  text: string;
}

function attachNotFoundTracker(page: Page, sink: ConsoleLog[], viewport: string, phase: () => string): void {
  page.on("response", (response) => {
    if (response.status() === 404) {
      sink.push({ viewport, phase: phase(), type: "http404", text: response.url() });
    }
  });
}

function attachConsoleCollector(page: Page, sink: ConsoleLog[], viewport: string, phase: () => string): void {
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      sink.push({ viewport, phase: phase(), type: "console", text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    sink.push({ viewport, phase: phase(), type: "pageerror", text: String(error) });
  });
}

function realConsoleErrors(entries: ConsoleLog[]): ConsoleLog[] {
  // Console/pageerror only; HTTP 404s are tracked separately.
  return entries.filter((entry) => entry.type !== "http404" && !/favicon/i.test(entry.text));
}

function notFoundRequests(entries: ConsoleLog[]): ConsoleLog[] {
  return entries.filter((entry) => entry.type === "http404" && !/favicon/i.test(entry.text));
}

async function noHorizontalOverflow(page: Page): Promise<{ ok: boolean; detail: string }> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  return {
    ok: metrics.scrollWidth <= metrics.clientWidth + 1,
    detail: `scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}`
  };
}

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return rejectPort(new Error("no port"));
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

interface ViewportRun {
  name: string;
  width: number;
  height: number;
  consoleErrors: ConsoleLog[];
  screenshot: string;
}

async function runViewport(
  browser: Browser,
  baseUrl: string,
  viewport: (typeof VIEWPORTS)[number],
  report: GateReport
): Promise<ViewportRun> {
  const consoleSink: ConsoleLog[] = [];
  let phase = "bootstrap";
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  attachConsoleCollector(page, consoleSink, viewport.name, () => phase);
  attachNotFoundTracker(page, consoleSink, viewport.name, () => phase);
  const screenshotPath = join(artifactsDir, `dashboard-${viewport.name}-${viewport.width}x${viewport.height}.png`);

  try {
    phase = "anonymous redirects";
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForURL(/\/login$/, { timeout: 15_000 });
    await page.waitForSelector("text=使用 Google 登入", { timeout: 15_000 });
    const anonymousBody = await page.textContent("body");
    report.expect(
      Boolean(anonymousBody) && !anonymousBody!.includes("Alpha Botany"),
      `[${viewport.name}] unauthenticated /dashboard redirects to /login without book content`
    );

    for (const protectedPath of ["/books", "/books/book-alpha"]) {
      await page.goto(`${baseUrl}${protectedPath}`, { waitUntil: "networkidle" });
      await page.waitForURL(/\/login$/, { timeout: 15_000 });
      report.pass(`[${viewport.name}] unauthenticated ${protectedPath} redirects to /login`);
    }

    phase = "oauth login";
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=使用 Google 登入", { timeout: 15_000 });
    await page.click("text=使用 Google 登入");
    await page.waitForURL(/\/profile-completion/, { timeout: 30_000 });
    report.pass(`[${viewport.name}] real OAuth round trip lands on /profile-completion`);

    phase = "profile completion";
    await page.fill("#student-display-name", "Browser Smoke Student");
    await page.fill("#student-school-name", "Smoke University");
    await page.fill("#student-grade-level", "Year 1");
    await page.click("text=儲存並開始學習");
    await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });
    await page.waitForSelector("text=已登入學員", { timeout: 15_000 });
    const dashboardBody = await page.textContent("body");
    report.expect(
      Boolean(dashboardBody) && dashboardBody!.includes("Browser Smoke Student"),
      `[${viewport.name}] dashboard renders the real session profile name`
    );
    const dashboardOverflow = await noHorizontalOverflow(page);
    report.expect(dashboardOverflow.ok, `[${viewport.name}] dashboard has no horizontal overflow`, dashboardOverflow.detail);

    phase = "books";
    await page.goto(`${baseUrl}/books`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Alpha Botany", { timeout: 15_000 });
    const booksBody = await page.textContent("body");
    report.expect(
      Boolean(booksBody) && booksBody!.includes("Beta Hydrology"),
      `[${viewport.name}] authenticated /books lists seeded books`
    );
    const booksOverflow = await noHorizontalOverflow(page);
    report.expect(booksOverflow.ok, `[${viewport.name}] books list has no horizontal overflow`, booksOverflow.detail);

    phase = "book detail";
    await page.goto(`${baseUrl}/books/book-alpha`, { waitUntil: "networkidle" });
    await page.waitForSelector("option[value=\"ch-alpha-1\"]", { state: "attached", timeout: 20_000 });
    report.pass(`[${viewport.name}] authenticated /books/book-alpha renders chapter outline`);
    const readerOverflow = await noHorizontalOverflow(page);
    report.expect(readerOverflow.ok, `[${viewport.name}] book reader has no horizontal overflow`, readerOverflow.detail);

    phase = "screenshot";
    await page.screenshot({ path: screenshotPath, fullPage: false });
    report.pass(`[${viewport.name}] screenshot captured`, screenshotPath);
  } finally {
    await context.close();
  }
  return { ...viewport, consoleErrors: consoleSink, screenshot: screenshotPath };
}

async function verifySessionExpiryUi(
  browser: Browser,
  baseUrl: string,
  authDbPath: string,
  report: GateReport
): Promise<ConsoleLog[]> {
  const consoleSink: ConsoleLog[] = [];
  let phase = "expiry-login";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  attachConsoleCollector(page, consoleSink, "expiry", () => phase);
  attachNotFoundTracker(page, consoleSink, "expiry", () => phase);
  try {
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=使用 Google 登入", { timeout: 15_000 });
    await page.click("text=使用 Google 登入");
    await page.waitForURL(/\/profile-completion/, { timeout: 30_000 });
    await page.fill("#student-display-name", "Expiry Student");
    await page.fill("#student-school-name", "Smoke University");
    await page.fill("#student-grade-level", "Year 1");
    await page.click("text=儲存並開始學習");
    await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });
    await page.waitForSelector("text=已登入學員", { timeout: 15_000 });
    report.pass("[expiry] session holder reaches dashboard before expiry");

    phase = "expiry-enforced";
    expireAllSessions(authDbPath);
    await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
    await page.waitForURL(/\/login$/, { timeout: 15_000 });
    const body = await page.textContent("body");
    report.expect(
      Boolean(body) && !body!.includes("已登入學員"),
      "[expiry] expired session is bounced back to /login in the UI"
    );
  } finally {
    await context.close();
  }
  return consoleSink;
}

async function main(): Promise<void> {
  const report = new GateReport();
  console.log("student:dashboard-smoke — real browser gate");
  mkdirSync(artifactsDir, { recursive: true });
  ensureStudentBundle();
  if (!existsSync(CHROMIUM_PATH)) {
    throw new Error(`chromium executable not found at ${CHROMIUM_PATH} (set STUDENT_SMOKE_CHROMIUM)`);
  }
  const { chromium } = await import("playwright-core");

  const workDir = createThrowawayDir("ai-student-dashboard-smoke-");
  const studentDbPath = join(workDir, "student.db");
  const authDbPath = join(workDir, "auth.db");
  seedThrowawayStudentDb(studentDbPath);

  const provider = await startFakeGoogleProvider();
  const port = await getFreePort();
  const api = await startStudentApi({
    port,
    studentDbPath,
    authDbPath,
    sessionTtlMs: 3_600_000,
    publicDir: join(repoRoot, "apps/AI-Stu-R1/dist"),
    googleEndpoints: {
      authorize: `${provider.baseUrl}/authorize`,
      token: `${provider.baseUrl}/token`,
      userinfo: `${provider.baseUrl}/userinfo`
    }
  });

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, headless: true });
  const runs: ViewportRun[] = [];
  try {
    for (const viewport of VIEWPORTS) {
      // Fresh Google subject per viewport: every run must hit the
      // incomplete-profile path against the shared auth database.
      provider.setSubject(`smoke-subject-${viewport.name}`);
      runs.push(await runViewport(browser, api.baseUrl, viewport, report));
    }
    provider.setSubject("smoke-subject-expiry");
    const expiryErrors = await verifySessionExpiryUi(browser, api.baseUrl, authDbPath, report);
    runs.push({ name: "expiry", width: 1440, height: 900, consoleErrors: expiryErrors, screenshot: "" });

    for (const run of runs) {
      const missing = notFoundRequests(run.consoleErrors);
      report.expect(
        missing.length === 0,
        `[${run.name}] no unexpected 404 requests`,
        missing.length === 0 ? undefined : JSON.stringify(missing.map((entry) => entry.text).slice(0, 3))
      );
      const realErrors = realConsoleErrors(run.consoleErrors);
      report.expect(
        realErrors.length === 0,
        `[${run.name}] no console errors`,
        realErrors.length === 0 ? undefined : JSON.stringify(realErrors.slice(0, 3))
      );
    }
  } finally {
    await browser.close();
    await api.close();
    await provider.close();
  }

  const evidence = {
    gate: "student:dashboard-smoke",
    completedAt: new Date().toISOString(),
    baseUrl: api.baseUrl,
    chromium: CHROMIUM_PATH,
    steps: report.steps,
    viewports: runs.map((run) => ({
      name: run.name,
      width: run.width,
      height: run.height,
      consoleErrors: realConsoleErrors(run.consoleErrors),
      notFoundRequests: notFoundRequests(run.consoleErrors).map((entry) => ({ phase: entry.phase, url: entry.text })),
      screenshot: run.screenshot || null
    }))
  };
  const evidencePath = join(artifactsDir, "dashboard-smoke.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`student:dashboard-smoke PASS (${report.steps.length} checks) — evidence: ${evidencePath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
