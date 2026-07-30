import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoFile = (relative: string) =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

describe("guest answer public surface", () => {
  it("does not render the removed internal process note", () => {
    const page = readFileSync(repoFile("apps/AI-Stu-R1/src/pages/PublicHomePage.tsx"), "utf8");
    expect(page).not.toContain("處理流程：");
    expect(page).not.toContain("guest-process-note");
    expect(page).toContain("正式 AI");
    expect(page).toContain("Mock 示範");
  });

  it("returns the allowlisted structured answer instead of raw provider metadata", () => {
    const api = readFileSync(repoFile("apps/AI-adm-D1/src/server/index.ts"), "utf8");
    const start = api.indexOf('app.post("/api/public/guest-ask"');
    const end = api.indexOf('app.get("/api/public/guest-ask/:requestId"');
    const route = api.slice(start, end);
    expect(route).toContain("studentAnswer.markdownText");
    expect(route).toContain("structuredAnswer: studentAnswer");
    expect(route).not.toContain("answer: result.answer");
    expect(route).not.toContain("metadata:");
    expect(route).not.toContain("處理流程：");
    expect(route).not.toContain("安全檢查");
    expect(route).not.toContain("問題分類");
  });

  it("issues a one-time recovery token on answer creation (not IP-based auth)", () => {
    const api = readFileSync(repoFile("apps/AI-adm-D1/src/server/index.ts"), "utf8");
    const start = api.indexOf('app.post("/api/public/guest-ask"');
    const end = api.indexOf('app.get("/api/public/guest-ask/:requestId"');
    const route = api.slice(start, end);
    // A high-entropy recovery token is generated and persisted only as a digest.
    expect(route).toContain("generateRecoveryToken()");
    expect(route).toContain("digestRecoveryToken(");
    expect(route).toContain("recoveryTokenDigest");
    // The raw token is returned exactly once in the creation response.
    expect(route).toMatch(/recoveryToken,/);
    // No plain SHA-256 IP hash remains; IP uses HMAC and is not the auth factor.
    expect(route).not.toContain("hashVisitorIp(");
    expect(route).not.toContain("SHA-256(IP)");
  });

  it("authorizes recovery via the recovery token header, not IP", () => {
    const api = readFileSync(repoFile("apps/AI-adm-D1/src/server/index.ts"), "utf8");
    const start = api.indexOf('app.get("/api/public/guest-ask/:requestId"');
    const end = api.indexOf('app.post("/api/public/guest-feedback"');
    const route = api.slice(start, end);
    // Recovery reads the token from a header (never a URL query string).
    expect(route).toContain('x-guest-recovery-token');
    expect(route).not.toContain("hashVisitorIp(");
    expect(route).toContain("findActiveByRequestIdAndTokenDigest");
    // The recovery response must not echo the token.
    expect(route).not.toMatch(/recoveryToken,/);
  });

  it("does not persist raw diagnostics; uses the allowlist mapper", () => {
    const logger = readFileSync(
      repoFile("apps/AI-adm-D1/src/server/ai/db-prompt-logger.ts"),
      "utf8"
    );
    expect(logger).toContain("toSafeAiDiagnostics");
    expect(logger).not.toMatch(/JSON\.stringify\(entry\.diagnostics\)/);
  });

  it("sends the recovery token via header and stores it client-side", () => {
    const client = readFileSync(repoFile("apps/AI-Stu-R1/src/studentClient.ts"), "utf8");
    expect(client).toContain('"x-guest-recovery-token"');
    expect(client).toContain("recoveryToken");
    const page = readFileSync(repoFile("apps/AI-Stu-R1/src/pages/PublicHomePage.tsx"), "utf8");
    // The client persists a {requestId, recoveryToken} credential, not a bare id.
    expect(page).toContain("recoveryToken");
    expect(page).toContain("saveGuestAnswerCredential");
    expect(page).toContain("readGuestAnswerCredential");
  });
});
