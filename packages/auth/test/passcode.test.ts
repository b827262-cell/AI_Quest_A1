import { describe, expect, it } from "vitest";
import { createStudentPasscodeThrottle, generateStudentPasscode, hashStudentPasscode, verifyStudentPasscode } from "../src/passcode";

describe("student passcodes", () => {
  it("generates codes and verifies only the correct value", async () => {
    const code = generateStudentPasscode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    const hash = hashStudentPasscode(code);
    expect(hash).not.toContain(code);
    expect(await verifyStudentPasscode(code, hash)).toBe(true);
    expect(await verifyStudentPasscode("wrong", hash)).toBe(false);
    expect(await verifyStudentPasscode(code)).toBe(false);
  });
  it("limits each email after five failures and each IP after ten", () => {
    const throttle = createStudentPasscodeThrottle();
    for (let i = 0; i < 5; i++) expect(throttle.reserve(`ip${i}`, "email", 1).allowed).toBe(true);
    expect(throttle.reserve("ip6", "email", 1).allowed).toBe(false);
    for (let i = 0; i < 10; i++) expect(throttle.reserve("ip", `email${i}`, 1).allowed).toBe(true);
    expect(throttle.reserve("ip", "other", 1).allowed).toBe(false);
    expect(throttle.reserve("ip", "other", 900_002).allowed).toBe(true);
  });
});
