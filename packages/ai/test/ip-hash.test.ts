import { describe, expect, it } from "vitest";
import { hmacVisitorIp, resolveGuestAskIpHmacSecret } from "../src/server/ip-hash";

describe("guest-ask IP HMAC", () => {
  it("is deterministic for the same ip + secret", () => {
    const a = hmacVisitorIp("203.0.113.42", "secret-A");
    const b = hmacVisitorIp("203.0.113.42", "secret-A");
    expect(a).toBe(b);
  });

  it("differs across secrets (per-deploy isolation)", () => {
    const a = hmacVisitorIp("203.0.113.42", "secret-A");
    const b = hmacVisitorIp("203.0.113.42", "secret-B");
    expect(a).not.toBe(b);
  });

  it("differs across ips", () => {
    expect(hmacVisitorIp("203.0.113.1", "s")).not.toBe(hmacVisitorIp("203.0.113.2", "s"));
  });

  it("does not leak the raw IP into the digest", () => {
    const digest = hmacVisitorIp("203.0.113.42", "secret-A");
    expect(digest).not.toContain("203");
    expect(digest).not.toContain("113");
    // HMAC-SHA-256 full hex digest (not the old truncated 32-char plain hash)
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is an HMAC, not a plain SHA-256 hash (different length than legacy)", () => {
    // Legacy plain hash was sliced to 32 hex chars; the HMAC is the full
    // 64-char digest. This guards against reintroducing the enumerably-weak
    // plain hash.
    expect(hmacVisitorIp("203.0.113.42", "secret-A").length).toBe(64);
  });

  it("handles empty input deterministically (maps to 'anonymous')", () => {
    expect(hmacVisitorIp("", "s")).toBe(hmacVisitorIp("anonymous", "s"));
  });

  it("falls back to a stable dev secret when env unset", () => {
    expect(resolveGuestAskIpHmacSecret({})).toBe("ai-smartbook-guest-ask-dev-hmac");
    expect(resolveGuestAskIpHmacSecret({ GUEST_ASK_IP_HMAC_SECRET: "prod-secret" })).toBe("prod-secret");
  });

  it("refuses a fixed fallback secret in production (fail-closed)", () => {
    expect(() => resolveGuestAskIpHmacSecret({ NODE_ENV: "production" })).toThrow(
      "GUEST_ASK_IP_HMAC_SECRET"
    );
  });

  it("does not accept AI_IP_HASH_SALT as the guest-ask HMAC secret", () => {
    // The dedicated secret must not be confused with the legacy generic salt.
    expect(resolveGuestAskIpHmacSecret({ AI_IP_HASH_SALT: "legacy-salt" })).toBe(
      "ai-smartbook-guest-ask-dev-hmac"
    );
  });
});
