import { afterEach, describe, expect, it } from "vitest";
import { rawHttpRequest, startStudentTestApp, type StudentTestApp } from "./testApp";

let app: StudentTestApp | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

async function start(): Promise<string> {
  app = await startStudentTestApp({ sessionTtlMs: 3_600_000 });
  return app.baseUrl;
}

function jsonBody(response: { bodyText: string }): unknown {
  return JSON.parse(response.bodyText);
}

describe("unknown /api/* answers JSON 404 (student server)", () => {
  it("returns a structured JSON 404 for an unknown GET", async () => {
    const baseUrl = await start();
    const response = await rawHttpRequest(new URL(`${baseUrl}/api/definitely-not-a-route`));
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]?.[0]).toMatch(/^application\/json/);
    expect(jsonBody(response)).toEqual({ error: "NOT_FOUND" });
    expect(response.bodyText).not.toMatch(/Cannot GET|<html|at .*\.ts:/i);
  });

  it("returns a structured JSON 404 for an unknown POST", async () => {
    const baseUrl = await start();
    const response = await rawHttpRequest(new URL(`${baseUrl}/api/definitely-not-a-route`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anything: true })
    });
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]?.[0]).toMatch(/^application\/json/);
    expect(jsonBody(response)).toEqual({ error: "NOT_FOUND" });
  });

  it("still answers malformed JSON with 400 INVALID_JSON", async () => {
    const baseUrl = await start();
    const response = await rawHttpRequest(new URL(`${baseUrl}/api/definitely-not-a-route`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"broken":'
    });
    expect(response.status).toBe(400);
    expect(jsonBody(response)).toEqual({ error: "INVALID_JSON" });
  });

  it("leaves non-API 404s on the default HTML page", async () => {
    const baseUrl = await start();
    const response = await rawHttpRequest(new URL(`${baseUrl}/definitely-not-a-page`));
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]?.[0]).toMatch(/^text\/html/);
  });

  it("keeps real routes working", async () => {
    const baseUrl = await start();
    const response = await rawHttpRequest(new URL(`${baseUrl}/health/live`));
    expect(response.status).toBe(200);
  });
});
