import { describe, expect, it, vi } from "vitest";
import { createGuestUsageStore, DEFAULT_GUEST_USAGE_CAPACITY } from "./guest-usage-store";

const day = "2026-11-12";
describe("bounded guest usage", () => {
  it("uses the expected default and rejects invalid parameters", () => {
    expect(createGuestUsageStore().capacity).toBe(100_000);
    expect(DEFAULT_GUEST_USAGE_CAPACITY).toBe(100_000);
    for (const options of [{ capacity: 0 }, { capacity: 1.5 }, { sweepEvery: 0 }, { sweepEvery: Infinity }]) expect(() => createGuestUsageStore(options)).toThrow(RangeError);
  });
  it("lazily expires keys and does not sweep on every access", () => {
    const store = createGuestUsageStore({ capacity: 4, sweepEvery: 3 });
    store.consume("a", "2026-11-11", 3, 1);
    store.consume("b", "2026-11-11", 3, 2);
    expect(store.get("a", day)).toBeUndefined();
    expect(store.size()).toBe(1);
    store.get("missing", day);
    expect(store.size()).toBe(1);
    store.get("missing", day);
    expect(store.size()).toBe(0);
  });
  it("evicts expired entries first and then the oldest unexhausted", () => {
    const store = createGuestUsageStore({ capacity: 2, sweepEvery: 100 });
    store.consume("current", day, 3, 1);
    store.consume("expired", "2026-11-11", 3, 2);
    expect(store.consume("new", day, 3, 3)).toBeDefined();
    expect(store.get("current", day)?.count).toBe(1);
    expect(store.get("expired", day)).toBeUndefined();
    store.consume("fresh", day, 3, 4);
    expect(store.get("current", day)).toBeUndefined();
  });
  it("refuses capacity without creating or consuming a key and warns without identifiers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = createGuestUsageStore({ capacity: 1 });
      store.consume("private-ip", day, 1, 100);
      expect(store.consume("new-ip", day, 1, 101)).toBeUndefined();
      expect(store.consume("new-ip", day, 1, 102)).toBeUndefined();
      expect(store.get("new-ip", day)).toBeUndefined();
      expect(store.get("private-ip", day)?.count).toBe(1);
      expect(warn).toHaveBeenCalledExactlyOnceWith("Guest usage capacity exhausted; refusing new identities");
    } finally { warn.mockRestore(); }
  });
  it("expires saturation at one hour after the latest attempt", () => {
    const store = createGuestUsageStore({ capacity: 1, warn: () => {} });
    store.consume("old", day, 1, 100);
    expect(store.consume("new", day, 1, 101)).toBeUndefined();
    store.touch("old", day, 200);
    expect(store.consume("new", day, 1, 3_600_200)).toBeUndefined();
    expect(store.consume("new", day, 1, 3_600_201)?.count).toBe(1);
    expect(store.get("old", day)).toBeUndefined();
  });
  it("rechecks when the limit increases and allows existing keys at capacity", () => {
    const store = createGuestUsageStore({ capacity: 1, warn: () => {} });
    store.consume("old", day, 1, 100);
    expect(store.consume("new", day, 1, 101)).toBeUndefined();
    expect(store.consume("old", day, 2, 102)?.count).toBe(2);
    expect(store.consume("new", day, 2, 103)).toBeUndefined();
    expect(store.consume("new", day, 3, 104)?.count).toBe(1);
    expect(store.get("old", day)).toBeUndefined();
  });
  it("keeps the saturation cache while exhausted keys are touched", () => {
    const store = createGuestUsageStore({ capacity: 2, sweepEvery: 1000, warn: () => {} });
    store.consume("a", day, 1, 100);
    store.consume("b", day, 1, 100);
    expect(store.consume("new", day, 1, 101)).toBeUndefined();
    const iterator = vi.spyOn(Map.prototype, Symbol.iterator);
    try {
      for (let i = 0; i < 10; i++) {
        store.touch("a", day, 200 + i);
        expect(store.consume(`new${i}`, day, 1, 200 + i)).toBeUndefined();
      }
      expect(iterator).not.toHaveBeenCalled();
    } finally { iterator.mockRestore(); }
    expect(store.consume("new", day, 1, 3_600_101)?.count).toBe(1);
  });
  it("never increments an exhausted key or creates one with zero limit", () => {
    const store = createGuestUsageStore({ capacity: 1 });
    expect(store.consume("zero", day, 0, 1)).toBeUndefined();
    expect(store.size()).toBe(0);
    expect(store.consume("a", day, 1, 2)?.count).toBe(1);
    expect(store.consume("a", day, 1, 3)).toBeUndefined();
    expect(store.get("a", day)?.count).toBe(1);
  });
});
