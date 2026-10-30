import { afterEach, describe, expect, it } from "vitest";
import { rawHttpRequest, startStudentTestApp, type StudentTestApp } from "./testApp";

/**
 * F2-HEALTH-01: the student API must expose the same public liveness/readiness
 * probes as the admin API. Every case below runs against the real express
 * boundary over TCP with no session cookie.
 */

let app: StudentTestApp | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

async function probe(path: string) {
  const response = await rawHttpRequest(new URL(`${app!.baseUrl}${path}`));
  return { ...response, payload: JSON.parse(response.bodyText) as unknown };
}

describe("Student API health probes over real HTTP", () => {
  it("answers /health/live with 200 for an unauthenticated caller", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const response = await probe("/health/live");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]?.[0]).toContain("application/json");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.payload).toEqual({ status: "live" });
  });

  it("answers /health/ready with 200 after a read-only data source probe", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    const response = await probe("/health/ready");
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.payload).toEqual({ status: "ready" });
  });

  it("answers 503 not_ready when the readiness probe throws", async () => {
    app = await startStudentTestApp({
      sessionTtlMs: 3_600_000,
      readyCheck: async () => {
        throw new Error("SENTINEL_DATABASE_DOWN");
      }
    });
    const response = await probe("/health/ready");
    expect(response.status).toBe(503);
    expect(response.payload).toEqual({ status: "not_ready" });
    // The failure reason must not leak to the caller.
    expect(response.bodyText).not.toContain("SENTINEL_DATABASE_DOWN");
    expect(response.bodyText).not.toContain("<!DOCTYPE");
  });

  it("returns only the status literal, never application data", async () => {
    app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
    for (const path of ["/health/live", "/health/ready"]) {
      const response = await probe(path);
      expect(response.status, path).toBe(200);
      expect(Object.keys(response.payload as Record<string, unknown>), path).toEqual(["status"]);
      expect(response.bodyText, path).not.toContain("book-alpha");
      expect(response.bodyText, path).not.toContain("Alpha Botany");
      expect(response.bodyText, path).not.toContain("<!DOCTYPE");
    }
  });
});
