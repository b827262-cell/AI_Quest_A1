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
    for (let i = 0; i < 100; i++) throttle.reserve(`ip${i}`, `${i}@example.test`, 2);
    expect(throttle.keyCount()).toBeLessThanOrEqual(8);
    expect(throttle.reserve("fresh-ip", "another@example.test", 2).allowed).toBe(true);
    expect(throttle.reserve("new-ip", "new@example.test", 900_003).allowed).toBe(true);
    expect(throttle.keyCount()).toBeLessThanOrEqual(8);
    expect(throttle.reserve("ip", "x".repeat(321), 900_003).allowed).toBe(false);
  });
  it("evicts the least recently updated keys independently and keeps recently updated keys", () => {
    const throttle = createStudentPasscodeThrottle(4);
    for (let i = 0; i < 4; i++) expect(throttle.reserve("hot-ip", "hot@example.test", 1).allowed).toBe(true);
    expect(throttle.reserve("old-ip", "old@example.test", 2).allowed).toBe(true);
    expect(throttle.reserve("hot-ip", "hot@example.test", 3).allowed).toBe(true);
    expect(throttle.reserve("new-ip", "new@example.test", 4).allowed).toBe(true);
    expect(throttle.keyCount()).toBe(4);
    expect(throttle.reserve("hot-ip", "hot@example.test", 5).allowed).toBe(false);
    expect(throttle.reserve("old-ip", "old@example.test", 6).allowed).toBe(true);
    expect(throttle.keyCount()).toBe(4);
  });
  it("preserves the recently updated IP when a new IP evicts an older one", () => {
    const throttle = createStudentPasscodeThrottle(4);
    for (let i = 0; i < 9; i++) expect(throttle.reserve("hot-ip", `a${i}@test`, 1).allowed).toBe(true);
    expect(throttle.reserve("old-ip", "b@test", 2).allowed).toBe(true);
    expect(throttle.reserve("hot-ip", "c@test", 3).allowed).toBe(true);
    expect(throttle.reserve("new-ip", "d@test", 4).allowed).toBe(true);
    expect(throttle.reserve("hot-ip", "fresh@test", 5).allowed).toBe(false);
    expect(throttle.reserve("old-ip", "fresh@test", 6).allowed).toBe(true);
    expect(throttle.keyCount()).toBeLessThanOrEqual(4);
  });
  it("preserves the recently updated email when a new email evicts an older one", () => {
    const throttle = createStudentPasscodeThrottle(4);
    for (let i = 0; i < 4; i++) expect(throttle.reserve(`a${i}`, "hot@test", 1).allowed).toBe(true);
    expect(throttle.reserve("b", "old@test", 2).allowed).toBe(true);
    expect(throttle.reserve("c", "hot@test", 3).allowed).toBe(true);
    expect(throttle.reserve("d", "new@test", 4).allowed).toBe(true);
    expect(throttle.reserve("fresh", "hot@test", 5).allowed).toBe(false);
    expect(throttle.reserve("fresh", "old@test", 6).allowed).toBe(true);
    expect(throttle.keyCount()).toBeLessThanOrEqual(4);
  });
  it("does not evict locked buckets and fails closed when all slots are locked", () => {
    const throttle = createStudentPasscodeThrottle(2);
    for (let i = 0; i < 5; i++) expect(throttle.reserve("ip", "locked@test", 1).allowed).toBe(true);
    expect(throttle.reserve("other", "new@test", 2).allowed).toBe(false);
    expect(throttle.reserve("ip", "locked@test", 2).allowed).toBe(false);
    expect(throttle.reserve("other", "new@test", 900_002).allowed).toBe(true);
  });
  it("uses a separate unknown IP bucket", () => {
    const throttle = createStudentPasscodeThrottle();
    for (let i = 0; i < 10; i++) expect(throttle.reserve("", `u${i}`, 1).allowed).toBe(true);
    expect(throttle.reserve("unknown", "new", 1).allowed).toBe(false);
    expect(throttle.reserve("known", "new", 1).allowed).toBe(true);
  });
  it("bounds the default capacity at 10000 keys", () => {
    const throttle = createStudentPasscodeThrottle();
    for (let i = 0; i < 5001; i++) throttle.reserve(`ip${i}`, `email${i}`, 1);
    expect(throttle.keyCount()).toBe(10000);
  });
  it("returns the next available slot time and uses the later blocked bucket", () => {
    const throttle = createStudentPasscodeThrottle();
    for (let i = 0; i < 10; i++) expect(throttle.reserve("limited-ip", `other${i}@test`, 1000 + i * 1000).allowed).toBe(true);
    for (let i = 0; i < 5; i++) expect(throttle.reserve(`ip${i}`, "limited@test", 20000 + i * 1000).allowed).toBe(true);
    expect(throttle.reserve("limited-ip", "another@test", 25001)).toMatchObject({ allowed: false, retryAfter: 876 });
    expect(throttle.reserve("different-ip", "limited@test", 25001)).toMatchObject({ allowed: false, retryAfter: 895 });
    expect(throttle.reserve("limited-ip", "limited@test", 25001)).toMatchObject({ allowed: false, retryAfter: 895 });
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
