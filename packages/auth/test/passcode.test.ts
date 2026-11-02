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
  it("bounds both maps, clears expired keys and releases successful reservations", () => {
    const throttle = createStudentPasscodeThrottle(8);
    const first = throttle.reserve("ip", " First@Example.test ", 1);
    expect(first.allowed).toBe(true);
    first.finish(true);
    expect(throttle.keyCount()).toBe(0);
    for (let i = 0; i < 100; i++) throttle.reserve("ip", `${i}@example.test`, 2);
    expect(throttle.keyCount()).toBeLessThanOrEqual(8);
    expect(throttle.reserve("ip", "another@example.test", 2).allowed).toBe(false);
    expect(throttle.reserve("new-ip", "new@example.test", 900_003).allowed).toBe(true);
    expect(throttle.keyCount()).toBe(2);
    expect(throttle.reserve("ip", "x".repeat(321), 900_003).allowed).toBe(false);
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
