import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import {
  completeSmokeProfile,
  createSmokeBrowser,
  createThrowawayDir,
  GateReport,
  loginViaSmokeAccess,
  rawHttpRequest,
  repoRoot,
  seedThrowawayStudentDb,
  startStudentApi,
  type StudentApiHandle
} from "./student-smoke-harness";
import { startFakeAccessCerts } from "./student-access-fixture";

/**
 * student:reader-smoke — drives the REAL student API process (server/stu-api.ts)
 * over HTTP against a throwaway SQLite DB and PDF fixture:
 * public appearance settings -> auth boundary -> outline -> contents ->
 * reader PDF session -> pdf-view auth/streaming -> keyword chat -> 404 paths.
 */

const studentAppRequire = createRequire(join(repoRoot, "apps/AI-Stu-R1/package.json"));
const Database = studentAppRequire("better-sqlite3") as new (path: string) => {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
};
const { readerOutlineResponseSchema } = studentAppRequire("@ai-smartbook/schema") as typeof import("../packages/schema/src/index");

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address !== "string") resolvePort(address.port);
        else rejectPort(new Error("no free port"));
      });
    });
  });
}

function seedAlphaPdfFixture(studentDbPath: string, directory: string): { fileId: string; pdfPath: string } {
  const fileId = "file-alpha-pdf";
  const fileName = "alpha.pdf";
  const pdfPath = join(directory, fileName);
  const pdfBytes = Buffer.from("%PDF-1.4\n%%EOF\n", "utf8");
  writeFileSync(pdfPath, pdfBytes);

  const db = new Database(studentDbPath);
  try {
    db.prepare(
      "INSERT INTO book_files (id, book_id, file_name, file_path, file_type, file_size, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      fileId,
      "book-alpha",
      fileName,
      pdfPath,
      "application/pdf",
      pdfBytes.byteLength,
      "source_document",
      "2026-01-01T00:00:00.000Z"
    );
  } finally {
    db.close();
  }
  return { fileId, pdfPath };
}

function parseJsonObject(bodyText: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(bodyText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected JSON object response");
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  const report = new GateReport();
  const directory = createThrowawayDir("ai-quest-reader-smoke-");
  const studentDbPath = join(directory, "student.db");
  seedThrowawayStudentDb(studentDbPath);
  const { fileId } = seedAlphaPdfFixture(studentDbPath, directory);

  const certs = await startFakeAccessCerts();
  let api: StudentApiHandle | null = null;

  try {
    const port = await getFreePort();
    api = await startStudentApi({
      port,
      studentDbPath,
      authDbPath: join(directory, "auth.db"),
      sessionTtlMs: 3_600_000,
      accessCerts: certs
    });

    // 1. Public appearance settings require no auth.
    const appearance = await rawHttpRequest(new URL("/api/appearance-settings", api.baseUrl));
    const appearanceBody = appearance.status === 200 ? parseJsonObject(appearance.bodyText) : null;
    report.expect(
      appearance.status === 200 &&
        appearanceBody !== null &&
        typeof appearanceBody.settings === "object" &&
        appearanceBody.settings !== null,
      "GET /api/appearance-settings returns 200 with settings",
      `status=${appearance.status}`
    );

    const browser = createSmokeBrowser(api.baseUrl, api.baseUrl);

    // 2. Protected reader endpoints reject unauthenticated requests.
    const unauthRoutes: Array<{ label: string; path: string; method?: string; body?: unknown }> = [
      { label: "GET outline", path: "/api/student/books/book-alpha/outline" },
      { label: "GET contents", path: "/api/student/books/book-alpha/contents" },
      { label: "POST session", path: "/api/student/books/book-alpha/session", method: "POST", body: {} },
      { label: "POST chat", path: "/api/student/books/book-alpha/chat", method: "POST", body: { message: "光合作用" } }
    ];
    for (const route of unauthRoutes) {
      const res = await browser.request(route.path, {
        method: route.method,
        body: route.body
      });
      report.expect(res.status === 401, `unauthenticated ${route.label} rejected`, `status=${res.status}`);
    }

    // 3. Sign in and complete student profile.
    await loginViaSmokeAccess(browser, certs.assertion({ email: "reader-smoke@example.test" }));
    await completeSmokeProfile(browser, "Reader Smoke Student");

    // 4. Outline matches schema and includes seeded chapter ch-alpha-1.
    const outlineRes = await browser.request("/api/student/books/book-alpha/outline");
    const outlineJson: unknown = outlineRes.status === 200 ? JSON.parse(outlineRes.bodyText) : null;
    const outlineParsed = readerOutlineResponseSchema.safeParse(outlineJson);
    const hasAlphaChapter =
      outlineParsed.success && outlineParsed.data.outline.some((node) => node.id === "ch-alpha-1");
    report.expect(
      outlineRes.status === 200 && outlineParsed.success && hasAlphaChapter,
      "GET /outline returns valid schema containing ch-alpha-1",
      `status=${outlineRes.status} valid=${outlineParsed.success}`
    );

    // 5. Contents include seeded alpha-1.
    const contentsRes = await browser.request("/api/student/books/book-alpha/contents");
    const contentsBody = contentsRes.status === 200 ? parseJsonObject(contentsRes.bodyText) : null;
    const contentsList = Array.isArray(contentsBody?.contents) ? (contentsBody.contents as Array<{ id?: unknown }>) : [];
    report.expect(
      contentsRes.status === 200 && contentsList.some((item) => item.id === "alpha-1"),
      "GET /contents returns 200 including alpha-1",
      `status=${contentsRes.status} count=${contentsList.length}`
    );

    // 6. Reader PDF session creation and reuse.
    const firstSessionRes = await browser.request("/api/student/books/book-alpha/session", {
      method: "POST",
      body: {}
    });
    const firstSessionBody = firstSessionRes.status === 200 ? parseJsonObject(firstSessionRes.bodyText) : null;
    const sessionId = typeof firstSessionBody?.sessionId === "string" ? firstSessionBody.sessionId : "";
    report.expect(
      firstSessionRes.status === 200 && sessionId.length > 0,
      "POST /session returns 200 with sessionId",
      `status=${firstSessionRes.status}`
    );

    const secondSessionRes = await browser.request("/api/student/books/book-alpha/session", {
      method: "POST",
      body: { sessionId }
    });
    const secondSessionBody = secondSessionRes.status === 200 ? parseJsonObject(secondSessionRes.bodyText) : null;
    report.expect(
      secondSessionRes.status === 200 && secondSessionBody?.sessionId === sessionId,
      "second POST /session with { sessionId } returns same sessionId",
      `status=${secondSessionRes.status}`
    );

    // 7. pdf-view requires valid X-Student-Session-Id and streams application/pdf.
    const pdfPath = `/api/student/books/book-alpha/files/${fileId}/pdf-view`;
    const pdfMissingSession = await browser.request(pdfPath);
    report.expect(
      pdfMissingSession.status === 401,
      "GET /pdf-view without X-Student-Session-Id returns 401",
      `status=${pdfMissingSession.status}`
    );

    const pdfWrongSession = await browser.request(pdfPath, {
      headers: { "X-Student-Session-Id": "stu-wrong-session" }
    });
    report.expect(
      pdfWrongSession.status === 401,
      "GET /pdf-view with wrong X-Student-Session-Id returns 401",
      `status=${pdfWrongSession.status}`
    );

    const pdfValid = await browser.request(pdfPath, {
      headers: { "X-Student-Session-Id": sessionId }
    });
    const contentType = (pdfValid.headers["content-type"] ?? []).join(";").toLowerCase();
    report.expect(
      pdfValid.status === 200 &&
        contentType.includes("application/pdf") &&
        pdfValid.bodyText.startsWith("%PDF-"),
      "GET /pdf-view with valid session streams application/pdf",
      `status=${pdfValid.status} contentType=${contentType}`
    );

    // 8. Chat validation and keyword retrieval (both message and legacy question).
    const chatEmptyObj = await browser.request("/api/student/books/book-alpha/chat", {
      method: "POST",
      body: {}
    });
    report.expect(chatEmptyObj.status === 400, "POST /chat with {} returns 400", `status=${chatEmptyObj.status}`);

    const chatWhitespace = await browser.request("/api/student/books/book-alpha/chat", {
      method: "POST",
      body: { message: "   " }
    });
    report.expect(
      chatWhitespace.status === 400,
      "POST /chat with whitespace message returns 400",
      `status=${chatWhitespace.status}`
    );

    const chatMessageRes = await browser.request("/api/student/books/book-alpha/chat", {
      method: "POST",
      body: { message: "光合作用是什麼？" }
    });
    const chatMessageBody = chatMessageRes.status === 200 ? parseJsonObject(chatMessageRes.bodyText) : null;
    const messageMatched = Array.isArray(chatMessageBody?.matchedContentIds)
      ? (chatMessageBody.matchedContentIds as unknown[])
      : [];
    report.expect(
      chatMessageRes.status === 200 &&
        typeof chatMessageBody?.answer === "string" &&
        chatMessageBody.answer.trim().length > 0 &&
        messageMatched.includes("alpha-1"),
      "POST /chat with Chinese message returns 200 with answer and alpha-1 match",
      `status=${chatMessageRes.status}`
    );

    const chatLegacyRes = await browser.request("/api/student/books/book-alpha/chat", {
      method: "POST",
      body: { question: "photosynthesis" }
    });
    const chatLegacyBody = chatLegacyRes.status === 200 ? parseJsonObject(chatLegacyRes.bodyText) : null;
    const legacyMatched = Array.isArray(chatLegacyBody?.matchedContentIds)
      ? (chatLegacyBody.matchedContentIds as unknown[])
      : [];
    report.expect(
      chatLegacyRes.status === 200 && legacyMatched.includes("alpha-1"),
      "POST /chat with legacy question returns 200 with alpha-1 match",
      `status=${chatLegacyRes.status}`
    );

    // 9. Negative 404 paths.
    const ghostOutline = await browser.request("/api/student/books/book-ghost/outline");
    report.expect(ghostOutline.status === 404, "GET /books/book-ghost/outline returns 404", `status=${ghostOutline.status}`);

    const ghostSession = await browser.request("/api/student/books/book-ghost/session", {
      method: "POST",
      body: {}
    });
    report.expect(ghostSession.status === 404, "POST /books/book-ghost/session returns 404", `status=${ghostSession.status}`);

    const ghostPdf = await browser.request("/api/student/books/book-alpha/files/file-does-not-exist/pdf-view", {
      headers: { "X-Student-Session-Id": sessionId }
    });
    report.expect(ghostPdf.status === 404, "GET /pdf-view for missing fileId returns 404", `status=${ghostPdf.status}`);

    console.log(`\nstudent:reader-smoke PASS (${report.steps.length} checks)`);
  } finally {
    await Promise.allSettled([api?.close(), certs.close()]);
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("\nstudent:reader-smoke FAIL");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
