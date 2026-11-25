import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getNormalizedAuth } from "./auth-helper";

type RuntimeWithBindings = Record<string, unknown> & { __env__?: Record<string, unknown> };

describe("auth-helper | relay.verify method classification", () => {
  const originalConsoleLog = console.log;
  const runtime = globalThis as unknown as RuntimeWithBindings;
  let loggedEvents: unknown[];
  let hadRelayModeBinding = false;
  let previousRelayModeBinding: unknown;

  beforeEach(() => {
    // readRelayMode() (site/lib/relay-verification.ts) resolves A01_RELAY_MODE
    // from globalThis / globalThis.__env__ only, so a process.env stub alone
    // leaves the mode at "off": normalizeRequestAuth() would take the legacy
    // path and logRelayVerification() would never run.
    hadRelayModeBinding = Object.prototype.hasOwnProperty.call(runtime, "A01_RELAY_MODE");
    previousRelayModeBinding = runtime.A01_RELAY_MODE;
    runtime.A01_RELAY_MODE = "transitional";
    vi.stubEnv("A01_RELAY_MODE", "transitional");
    // logRelayVerification() (auth-helper.ts) early-returns unless SITE_ROLE is
    // "primary"; auth-helper's readRuntimeString() falls back to process.env.
    vi.stubEnv("SITE_ROLE", "primary");

    loggedEvents = [];
    console.log = vi.fn((...args) => {
      // Collect only: do not re-emit to stdout (removes test noise).
      loggedEvents.push(args[0]);
    });
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    vi.unstubAllEnvs();
    if (hadRelayModeBinding) runtime.A01_RELAY_MODE = previousRelayModeBinding;
    else delete runtime.A01_RELAY_MODE;
  });

  function buildRequest(method: string, url: string): Request {
    return new Request(url, { method, headers: { "oai-authenticated-user-id": "test-user" } });
  }

  it("classifies GET as GET", async () => {
    const req = buildRequest("GET", "http://localhost/api/student");
    await getNormalizedAuth(req);
    expect(loggedEvents).toHaveLength(1);
    const event = JSON.parse(loggedEvents[0] as string);
    expect(event.method).toBe("GET");
    expect(event.evt).toBe("relay.verify");
    expect(event.result).toBe("none");
    expect(event.pathClass).toBe("student");
    expect(event.site).toBe("unknown");
    expect(event.mode).toBe("transitional");
    expect(event.identityPresent).toBe(true);
    expect(event.synthetic).toBe(false);
  });

  it("classifies HEAD as HEAD", async () => {
    const req = buildRequest("HEAD", "http://localhost/api/admin");
    await getNormalizedAuth(req);
    expect(loggedEvents).toHaveLength(1);
    const event = JSON.parse(loggedEvents[0] as string);
    expect(event.method).toBe("HEAD");
    expect(event.evt).toBe("relay.verify");
    expect(event.result).toBe("none");
    expect(event.pathClass).toBe("admin");
    expect(event.site).toBe("unknown");
    expect(event.mode).toBe("transitional");
    expect(event.identityPresent).toBe(true);
    expect(event.synthetic).toBe(false);
  });

  it("classifies PUT as PUT (actual verb)", async () => {
    const req = buildRequest("PUT", "http://localhost/api/student/progress");
    await getNormalizedAuth(req);
    expect(loggedEvents).toHaveLength(1);
    const event = JSON.parse(loggedEvents[0] as string);
    expect(event.method).toBe("PUT");
    expect(event.evt).toBe("relay.verify");
    expect(event.result).toBe("none");
    expect(event.pathClass).toBe("student");
    expect(event.site).toBe("unknown");
    expect(event.mode).toBe("transitional");
    expect(event.identityPresent).toBe(true);
    expect(event.synthetic).toBe(false);
  });

  it("classifies POST as POST (actual verb)", async () => {
    const req = buildRequest("POST", "http://localhost/api/admin/books");
    await getNormalizedAuth(req);
    expect(loggedEvents).toHaveLength(1);
    const event = JSON.parse(loggedEvents[0] as string);
    expect(event.method).toBe("POST");
    expect(event.evt).toBe("relay.verify");
    expect(event.result).toBe("none");
    expect(event.pathClass).toBe("admin");
    expect(event.site).toBe("unknown");
    expect(event.mode).toBe("transitional");
    expect(event.identityPresent).toBe(true);
    expect(event.synthetic).toBe(false);
  });

  it("classifies DELETE as DELETE (actual verb)", async () => {
    const req = buildRequest("DELETE", "http://localhost/api/student/profile");
    await getNormalizedAuth(req);
    expect(loggedEvents).toHaveLength(1);
    const event = JSON.parse(loggedEvents[0] as string);
    expect(event.method).toBe("DELETE");
    expect(event.evt).toBe("relay.verify");
    expect(event.result).toBe("none");
    expect(event.pathClass).toBe("student");
    expect(event.site).toBe("unknown");
    expect(event.mode).toBe("transitional");
    expect(event.identityPresent).toBe(true);
    expect(event.synthetic).toBe(false);
  });

  it("classifies PATCH as PATCH (actual verb)", async () => {
    const req = buildRequest("PATCH", "http://localhost/api/student/settings");
    await getNormalizedAuth(req);
    expect(loggedEvents).toHaveLength(1);
    const event = JSON.parse(loggedEvents[0] as string);
    expect(event.method).toBe("PATCH");
    expect(event.evt).toBe("relay.verify");
    expect(event.result).toBe("none");
    expect(event.pathClass).toBe("student");
    expect(event.site).toBe("unknown");
    expect(event.mode).toBe("transitional");
    expect(event.identityPresent).toBe(true);
    expect(event.synthetic).toBe(false);
  });

  it("classifies unknown verb OPTIONS as OTHER", async () => {
    const req = buildRequest("OPTIONS", "http://localhost/api/cors/preflight");
    await getNormalizedAuth(req);
    expect(loggedEvents).toHaveLength(1);
    const event = JSON.parse(loggedEvents[0] as string);
    expect(event.method).toBe("OTHER");
    expect(event.evt).toBe("relay.verify");
    expect(event.result).toBe("none");
    expect(event.pathClass).toBe("other");
    expect(event.site).toBe("unknown");
    expect(event.mode).toBe("transitional");
    expect(event.identityPresent).toBe(true);
    expect(event.synthetic).toBe(false);
  });

  it("classifies unknown verb TRACE as OTHER", async () => {
    // undici rejects TRACE in the Request constructor (forbidden method), so
    // shadow the method on a real GET Request instead: logRelayVerification()
    // still reads request.method and classifies it through the production path.
    const req = buildRequest("GET", "http://localhost/api/debug");
    Object.defineProperty(req, "method", { value: "TRACE", configurable: true });
    await getNormalizedAuth(req);
    expect(loggedEvents).toHaveLength(1);
    const event = JSON.parse(loggedEvents[0] as string);
    expect(event.method).toBe("OTHER");
    expect(event.evt).toBe("relay.verify");
    expect(event.result).toBe("none");
    expect(event.pathClass).toBe("other");
    expect(event.site).toBe("unknown");
    expect(event.mode).toBe("transitional");
    expect(event.identityPresent).toBe(true);
    expect(event.synthetic).toBe(false);
  });
});
