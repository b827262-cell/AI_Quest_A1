import { afterEach, describe, expect, it, vi } from "vitest";
import { createStudentAccessFixture, startFakeAccessCerts } from "../../../scripts/student-access-fixture";
import { AccessInvalidTokenError, AccessUnavailableError, verifyAccessAssertion } from "../src/access";

afterEach(() => vi.restoreAllMocks());

describe("Access certificate rotation", () => {
  it("accepts a new kid after one forced JWKS refresh", async () => {
    const oldKey = createStudentAccessFixture();
    const newKey = createStudentAccessFixture();
    const certs = await startFakeAccessCerts(oldKey);
    const config = { accessTeamDomain: certs.teamDomain, accessAud: certs.aud, accessCertsUrl: certs.certsUrl };
    try {
      expect(await verifyAccessAssertion(oldKey.assertion(), config)).toBe("student@example.test");
      expect(certs.requestCount()).toBe(1);
      oldKey.jwks.keys = newKey.jwks.keys;
      expect(await verifyAccessAssertion(newKey.assertion(), config)).toBe("student@example.test");
      expect(certs.requestCount()).toBe(2);
    } finally { await certs.close(); }
  });

  it("rejects unknown kids and bounds refreshes across a cooldown", async () => {
    const certs = await startFakeAccessCerts();
    const config = { accessTeamDomain: certs.teamDomain, accessAud: certs.aud, accessCertsUrl: certs.certsUrl };
    const start = Date.now();
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => start + offset);
    try {
      await verifyAccessAssertion(certs.assertion(), config);
      const unknown = (kid: string) => certs.assertion({}, { kid });
      await Promise.all(Array.from({ length: 12 }, (_, index) =>
        expect(verifyAccessAssertion(unknown(`missing-${index + 1}`), config)).rejects.toBeInstanceOf(AccessInvalidTokenError)));
      expect(certs.requestCount()).toBe(2);
      await expect(verifyAccessAssertion(unknown("another-missing"), config)).rejects.toBeInstanceOf(AccessInvalidTokenError);
      expect(certs.requestCount()).toBe(2);
      offset += 30_001;
      await expect(verifyAccessAssertion(unknown("still-missing"), config)).rejects.toBeInstanceOf(AccessInvalidTokenError);
      expect(certs.requestCount()).toBe(3);
    } finally { await certs.close(); }
  });

  it("does not retry a cold-cache unknown kid", async () => {
    const certs = await startFakeAccessCerts();
    const config = { accessTeamDomain: certs.teamDomain, accessAud: certs.aud, accessCertsUrl: certs.certsUrl };
    try {
      await expect(verifyAccessAssertion(certs.assertion({}, { kid: "never-published" }), config)).rejects.toBeInstanceOf(AccessInvalidTokenError);
      expect(certs.requestCount()).toBe(1);
    } finally { await certs.close(); }
  });

  it("reports a failed forced refresh as unavailable without repeated requests", async () => {
    const certs = await startFakeAccessCerts();
    const config = { accessTeamDomain: certs.teamDomain, accessAud: certs.aud, accessCertsUrl: certs.certsUrl };
    try {
      await verifyAccessAssertion(certs.assertion(), config);
      certs.setFailure(true);
      const unknown = certs.assertion({}, { kid: "missing-on-failure" });
      await expect(verifyAccessAssertion(unknown, config)).rejects.toBeInstanceOf(AccessUnavailableError);
      expect(certs.requestCount()).toBe(2);
      await expect(verifyAccessAssertion(unknown, config)).rejects.toBeInstanceOf(AccessInvalidTokenError);
      expect(certs.requestCount()).toBe(2);
    } finally { await certs.close(); }
  });
});
