import { describe, expect, it } from "vitest";
import {
  digestRecoveryToken,
  generateRecoveryToken,
  safeEqualDigest,
  GUEST_RECOVERY_DOMAIN
} from "../src/server/recovery-token";
import { hmacVisitorIp, GUEST_IP_DOMAIN } from "../src/server/ip-hash";

const SECRET = "test-guest-ask-hmac-secret";

describe("recovery token", () => {
  it("produces a 256-bit (64 hex char) token", () => {
    const token = generateRecoveryToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(token.length).toBe(64);
  });

  it("produces unique tokens with high entropy", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateRecoveryToken());
    }
    expect(seen.size).toBe(1000);
  });

  it("digests the same token deterministically for the same secret", () => {
    const token = generateRecoveryToken();
    expect(digestRecoveryToken(token, SECRET)).toBe(digestRecoveryToken(token, SECRET));
  });

  it("produces a full HMAC-SHA-256 digest (64 hex chars)", () => {
    const digest = digestRecoveryToken(generateRecoveryToken(), SECRET);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("digests differ across secrets", () => {
    const token = generateRecoveryToken();
    expect(digestRecoveryToken(token, SECRET)).not.toBe(
      digestRecoveryToken(token, "other-secret")
    );
  });

  it("the digest is not reversible to the token (no substring leak)", () => {
    const token = generateRecoveryToken();
    const digest = digestRecoveryToken(token, SECRET);
    // A 64-char hex digest of a 64-char hex token will share characters by
    // chance, but the token must not appear as a substring of the digest.
    expect(digest).not.toContain(token);
    expect(digest.slice(0, 32)).not.toBe(token.slice(0, 32));
  });

  it("rejects digesting an empty token", () => {
    expect(() => digestRecoveryToken("", SECRET)).toThrow();
  });

  it("safeEqualDigest matches identical digests", () => {
    const d = digestRecoveryToken(generateRecoveryToken(), SECRET);
    expect(safeEqualDigest(d, d)).toBe(true);
  });

  it("safeEqualDigest rejects different digests", () => {
    const a = digestRecoveryToken(generateRecoveryToken(), SECRET);
    const b = digestRecoveryToken(generateRecoveryToken(), SECRET);
    expect(safeEqualDigest(a, b)).toBe(false);
  });

  it("safeEqualDigest rejects empty or mismatched-length inputs", () => {
    expect(safeEqualDigest("", "")).toBe(false);
    expect(safeEqualDigest("abc", "abcd")).toBe(false);
  });
});

describe("key-use domain separation (IP HMAC vs recovery-token digest)", () => {
  // Both HMACs share GUEST_ASK_IP_HMAC_SECRET. Domain prefixes guarantee an IP
  // input can never yield the same digest as a recovery-token input, so the two
  // uses of the single secret cannot be confused or cross-substituted.
  it("uses distinct domain prefixes (guest-ip: vs guest-recovery:)", () => {
    expect(GUEST_IP_DOMAIN).toBe("guest-ip:");
    expect(GUEST_RECOVERY_DOMAIN).toBe("guest-recovery:");
    expect(GUEST_IP_DOMAIN).not.toBe(GUEST_RECOVERY_DOMAIN);
  });

  it("an IP HMAC never equals a recovery-token digest for any shared secret", () => {
    // Even when the IP string and the token string are identical, the digests
    // must differ because of the domain prefix.
    const same = "203.0.113.42";
    expect(hmacVisitorIp(same, SECRET)).not.toBe(digestRecoveryToken(same, SECRET));
  });

  it("a large sample of IP HMACs never collides with token digests", () => {
    const tokenDigests = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      tokenDigests.add(digestRecoveryToken(generateRecoveryToken(), SECRET));
    }
    for (let i = 0; i < 500; i += 1) {
      const ipHmac = hmacVisitorIp(`203.0.113.${i}`, SECRET);
      expect(tokenDigests.has(ipHmac)).toBe(false);
    }
  });

  it("the digest is not derivable without the domain prefix (raw HMAC differs)", () => {
    const { createHmac } = require("node:crypto");
    const token = generateRecoveryToken();
    const withDomain = digestRecoveryToken(token, SECRET);
    const withoutDomain = createHmac("sha256", SECRET).update(token).digest("hex");
    expect(withDomain).not.toBe(withoutDomain);
  });
});
