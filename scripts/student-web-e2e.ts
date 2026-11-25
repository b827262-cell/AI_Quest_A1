import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, ConsoleMessage, Page } from "playwright-core";
import {
  GateReport,
  createThrowawayDir,
  repoRoot,
  seedThrowawayStudentDb,
  startStudentApi,
  type StudentApiHandle
} from "./student-smoke-harness";
import { startFakeAccessCerts } from "./student-access-fixture";

/**
 * student:web-e2e — REAL Chromium Playwright E2E gate.
 *
 * Drives the built Student SPA (apps/AI-Stu-R1/dist) served by the real
 * server/stu-api.ts process against throwaway SQLite databases and a local
 * fake Cloudflare Access JWKS fixture. Covers:
 *   1. Public Home guest AI composer (#121 Google hint toggle + mock guest-ask)
 *   2. Access login -> profile completion -> /dashboard -> /books
 *   3. /books/book-alpha chapter outline + ChatPanel keyword-chat + BookRagPanel grounded RAG
 */

const GOOGLE_CONFIRM_HINT = "若 Google 跳出確認視窗，請捲到最下方，或按 End 鍵。";
const MOCK_GUEST_ANSWER = "光合作用是植物利用光能將水與二氧化碳轉化為養分與氧氣的過程。";
const artifactsDir = join(repoRoot, "release-artifacts/student-web-e2e");

interface ConsoleLog {
  phase: string;
  type: string;
  text: string;
}

function findChromiumExecutable(): string {
  const override = process.env.STUDENT_SMOKE_CHROMIUM?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`STUDENT_SMOKE_CHROMIUM points to a missing file: ${override}`);
    }
    return override;
  }

  const playwrightCache = join(homedir(), ".cache/ms-playwright");
  if (existsSync(playwrightCache)) {
    const entries = readdirSync(playwrightCache).sort().reverse();
    for (const entry of entries) {
      if (entry.startsWith("chromium-")) {
        const candidate = join(playwrightCache, entry, "chrome-linux64/chrome");
        if (existsSync(candidate)) return candidate;
      }
    }
    for (const entry of entries) {
      if (entry.startsWith("chromium_headless_shell-")) {
        const candidate = join(playwrightCache, entry, "chrome-headless-shell-linux64/chrome-headless-shell");
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  throw new Error(
    "Chromium executable not found. Set STUDENT_SMOKE_CHROMIUM or install Playwright Chromium under ~/.cache/ms-playwright/."
  );
}

function newestMtimeMs(dir: string): number {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = newestMtimeMs(full);
      if (nested > latest) latest = nested;
    } else if (entry.isFile()) {
      const mtime = statSync(full).mtimeMs;
      if (mtime > latest) latest = mtime;
    }
  }
  return latest;
}

function ensureStudentBundle(): void {
  const distEntry = join(repoRoot, "apps/AI-Stu-R1/dist/index.html");
  const distExists = existsSync(distEntry);
  if (distExists && process.env.STUDENT_E2E_SKIP_BUILD === "1") return;
  if (distExists) {
    const distMtime = statSync(distEntry).mtimeMs;
    const srcMtime = newestMtimeMs(join(repoRoot, "apps/AI-Stu-R1/src"));
    if (distMtime >= srcMtime) return;
    console.log("  … dist is older than src, rebuilding student bundle");
  } else {
    console.log("  … dist missing, building student bundle");
  }
  const build = spawnSync("pnpm", ["--filter", "AI-Stu-R1", "build"], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (build.status !== 0 || !existsSync(distEntry)) {
    throw new Error("student bundle build failed");
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("failed to allocate free TCP port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

function attachTrackers(page: Page, sink: ConsoleLog[], getPhase: () => string): void {
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      sink.push({ phase: getPhase(), type: "console", text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    sink.push({ phase: getPhase(), type: "pageerror", text: String(error) });
  });
  page.on("response", (response) => {
    if (response.status() === 404) {
      sink.push({ phase: getPhase(), type: "http404", text: response.url() });
    }
  });
}

function realConsoleErrors(entries: ConsoleLog[]): ConsoleLog[] {
  return entries.filter((entry) => entry.type !== "http404" && !/favicon/i.test(entry.text));
}

function notFoundRequests(entries: ConsoleLog[]): ConsoleLog[] {
  return entries.filter((entry) => entry.type === "http404" && !/favicon/i.test(entry.text));
}

async function installRoutes(page: Page, accessAssertion: string): Promise<void> {
  await page.route("**/api/public/site-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        siteTitle: "iBrain AI",
        siteSubtitle: "多模型領域智慧解題平台",
        homeGreeting: "今天想學習什麼？",
        homeInputPlaceholder: "輸入你的問題……",
        guestAiEnabled: true,
        guestDailyLimit: 3,
        studentLoginEnabled: true,
        maintenanceNotice: ""
      })
    });
  });

  await page.route("**/api/public/guest-quota", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        guestAiEnabled: true,
        dailyLimit: 3,
        usedCount: 0,
        remainingCount: 3,
        blocked: false
      })
    });
  });

  await page.route("**/api/public/guest-ask", async (route) => {
    let question = "請問什麼是光合作用？";
    try {
      const raw = route.request().postData();
      if (raw) {
        const parsed = JSON.parse(raw) as { question?: unknown };
        if (typeof parsed.question === "string" && parsed.question.trim()) {
          question = parsed.question.trim();
        }
      }
    } catch {
      // Ignore malformed body and fall back to default test question.
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        requestId: "req-e2e-guest-1",
        question,
        status: "success",
        mode: "mock",
        answer: MOCK_GUEST_ANSWER,
        remainingGuestQuestions: 2
      })
    });
  });

  await page.route("**/api/student/auth/access/login**", async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        "Cf-Access-Jwt-Assertion": accessAssertion
      }
    });
  });
}

async function main(): Promise<void> {
  const report = new GateReport();
  console.log("student:web-e2e — real Chromium E2E gate");
  mkdirSync(artifactsDir, { recursive: true });
  ensureStudentBundle();

  const chromiumPath = findChromiumExecutable();
  report.pass("Chromium executable detected", chromiumPath);

  const { chromium } = await import("playwright-core");
  const workDir = createThrowawayDir("ai-student-web-e2e-");
  const studentDbPath = join(workDir, "student.db");
  const authDbPath = join(workDir, "auth.db");
  seedThrowawayStudentDb(studentDbPath);

  let certs: Awaited<ReturnType<typeof startFakeAccessCerts>> | null = null;
  let api: StudentApiHandle | null = null;
  let browser: Browser | null = null;

  const consoleSink: ConsoleLog[] = [];
  let phase = "bootstrap";
  const screenshots: string[] = [];

  try {
    certs = await startFakeAccessCerts();
    const port = await getFreePort();
    api = await startStudentApi({
      port,
      studentDbPath,
      authDbPath,
      sessionTtlMs: 3_600_000,
      publicDir: join(repoRoot, "apps/AI-Stu-R1/dist"),
      accessCerts: certs,
      ragProvider: "fake",
      ragFakeMode: "grounded"
    });

    browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const assertion = certs.assertion({ email: "e2e-student@example.test" });
    await installRoutes(page, assertion);
    attachTrackers(page, consoleSink, () => phase);

    try {
      // Step 1: Public Home & #121
      phase = "step1-public-home";
      await page.goto(`${api.baseUrl}/`, { waitUntil: "networkidle" });

      const strategySelect = page.locator('select[aria-label="解答方式"]');
      await strategySelect.waitFor({ state: "visible", timeout: 15_000 });
      const initialStrategy = await strategySelect.inputValue();
      report.expect(initialStrategy === "google-ai", "default strategy is google-ai", initialStrategy);

      const googleHint = page.locator(".public-google-confirm-hint");
      await googleHint.waitFor({ state: "visible", timeout: 10_000 });
      const hintText = (await googleHint.textContent())?.trim() ?? "";
      report.expect(
        hintText.includes(GOOGLE_CONFIRM_HINT),
        "GOOGLE_CONFIRM_HINT is visible in google-ai mode"
      );

      await strategySelect.selectOption("api");
      await googleHint.waitFor({ state: "hidden", timeout: 10_000 });
      report.pass("GOOGLE_CONFIRM_HINT disappears when switching to api mode");

      const guestTextarea = page.locator('textarea[aria-label="訪客問題"]');
      await guestTextarea.fill("請問什麼是光合作用？");
      await page.locator('button[aria-label="送出問題"]').click();

      const answerCard = page.locator(".public-answer-card");
      await answerCard.waitFor({ state: "visible", timeout: 15_000 });
      const badgeText = (await answerCard.locator(".guest-answer-badge").textContent()) ?? "";
      const cardText = (await answerCard.textContent()) ?? "";
      report.expect(
        badgeText.includes("訪客體驗") && cardText.includes(MOCK_GUEST_ANSWER),
        "GuestAnswer card and mock answer render",
        "訪客體驗 + mock answer"
      );

      const step1Shot = join(artifactsDir, "step1-guest-answer.png");
      await page.screenshot({ path: step1Shot, fullPage: false });
      screenshots.push(step1Shot);

      // Step 2: Auth & Profile
      phase = "step2-auth-profile";
      await page.locator('a.public-login-button:has-text("學員登入")').first().click();
      await page.waitForURL(/\/login$/, { timeout: 15_000 });

      const accessLoginBtn = page.locator('button:has-text("以電子郵件登入（Cloudflare Access）")');
      await accessLoginBtn.waitFor({ state: "visible", timeout: 15_000 });
      await accessLoginBtn.click();

      await page.waitForURL(/\/profile-completion/, { timeout: 30_000 });
      report.pass("Access login redirects to /profile-completion");

      await page.fill("#student-display-name", "E2E Student");
      await page.fill("#student-school-name", "E2E University");
      await page.fill("#student-grade-level", "Year 1");
      await page.locator('button:has-text("儲存並開始學習")').click();

      await page.waitForURL(/\/(books|dashboard)$/, { timeout: 30_000 });
      report.pass("profile completion redirects into authenticated app", page.url());

      // Verify /dashboard renders the authenticated student profile
      if (!/\/dashboard$/.test(page.url())) {
        await page.locator("a.home-pill").click();
        await page.waitForURL(/\/dashboard$/, { timeout: 15_000 });
      }
      await page.waitForSelector("text=已登入學員", { timeout: 15_000 });
      const dashboardText = (await page.textContent("body")) ?? "";
      report.expect(
        dashboardText.includes("E2E Student"),
        "authenticated /dashboard renders student profile name"
      );

      await page.goto(`${api.baseUrl}/books`, { waitUntil: "networkidle" });
      await page.waitForSelector("text=Alpha Botany", { timeout: 15_000 });
      const booksText = (await page.textContent("body")) ?? "";
      report.expect(
        booksText.includes("Alpha Botany") && booksText.includes("Beta Hydrology"),
        "/books displays Alpha Botany and Beta Hydrology"
      );

      const step2Shot = join(artifactsDir, "step2-books.png");
      await page.screenshot({ path: step2Shot, fullPage: false });
      screenshots.push(step2Shot);

      // Step 3: Book Reader Chat & RAG
      phase = "step3-book-reader";
      await page.goto(`${api.baseUrl}/books/book-alpha`, { waitUntil: "networkidle" });
      await page.waitForSelector('option[value="ch-alpha-1"]', { state: "attached", timeout: 20_000 });
      report.pass("book-alpha chapter outline (ch-alpha-1) loads");

      // ChatPanel keyword-chat
      const chatInput = page.locator(".chat-wrap input.chat-text");
      await chatInput.waitFor({ state: "visible", timeout: 15_000 });
      await chatInput.fill("光合作用是什麼？");
      await page.locator('.chat-wrap form.chat-input-wrap button:has-text("送出")').click();

      const chatAnswerBubble = page.locator('.chat-wrap .bubble.assistant', {
        hasText: "根據書本內容，找到以下相關段落"
      });
      await chatAnswerBubble.waitFor({ state: "visible", timeout: 15_000 });
      const chatAnswerText = (await chatAnswerBubble.textContent()) ?? "";
      report.expect(
        chatAnswerText.includes("光合作用 photosynthesis 是植物利用光能將水與二氧化碳轉化為養分"),
        "ChatPanel renders keyword-chat answer from stu-api"
      );

      // BookRagPanel scoped RAG
      const ragInput = page.locator('input[aria-label="書本問題"]');
      await ragInput.waitFor({ state: "visible", timeout: 15_000 });
      await ragInput.fill("光合作用");
      await page.locator('button.book-rag-submit').click();

      const ragAnswerBox = page.locator(".book-rag-answer");
      await ragAnswerBox.waitFor({ state: "visible", timeout: 15_000 });
      await ragAnswerBox.locator(".book-rag-grounding-verified").waitFor({ state: "visible", timeout: 10_000 });
      const ragAnswerText = (await ragAnswerBox.textContent()) ?? "";
      const citationsBox = ragAnswerBox.locator(".book-rag-citations");
      await citationsBox.waitFor({ state: "visible", timeout: 10_000 });
      const citationsText = (await citationsBox.textContent()) ?? "";
      report.expect(
        ragAnswerText.includes("依據書本內容") &&
          ragAnswerText.includes("光合作用 photosynthesis") &&
          citationsText.includes("chapter:ch-alpha-1"),
        "BookRagPanel renders grounded RAG answer and citation"
      );

      const step3Shot = join(artifactsDir, "step3-reader-chat-rag.png");
      await page.screenshot({ path: step3Shot, fullPage: false });
      screenshots.push(step3Shot);
    } finally {
      await context.close();
    }

    const unexpected404s = notFoundRequests(consoleSink);
    report.expect(
      unexpected404s.length === 0,
      "no unexpected 404 responses",
      unexpected404s.length === 0 ? undefined : JSON.stringify(unexpected404s.slice(0, 5))
    );

    const errors = realConsoleErrors(consoleSink);
    report.expect(
      errors.length === 0,
      "no console errors or pageerrors",
      errors.length === 0 ? undefined : JSON.stringify(errors.slice(0, 5))
    );

    const evidencePath = join(artifactsDir, "student-web-e2e.json");
    const evidence = {
      gate: "student:web-e2e",
      completedAt: new Date().toISOString(),
      baseUrl: api.baseUrl,
      chromium: chromiumPath,
      steps: report.steps,
      screenshots,
      consoleErrors: errors,
      notFoundRequests: unexpected404s
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`student:web-e2e PASS (${report.steps.length} checks) — evidence: ${evidencePath}`);
  } finally {
    if (browser) await browser.close();
    if (api) await api.close();
    if (certs) await certs.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
