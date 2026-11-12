import { describe, expect, it, vi } from "vitest";
import { createGuestUsageStore } from "./guest-usage-store";

const day = "2026-11-12";
const usage = (count: number, lastAt: number, date = day) => ({ day: date, count, lastAt });

describe("bounded guest usage", () => {
  it("lazily removes an accessed previous-day entry and periodically sweeps others", () => {
    const store = createGuestUsageStore({ capacity: 4, sweepEvery: 3 });
    store.set("a", usage(3, 1, "2026-11-11"), 3);
    store.set("b", usage(3, 2, "2026-11-11"), 3);
    expect(store.get("a", day)).toBeUndefined();
    expect(store.size()).toBe(1);
    store.get("missing", day);
    expect(store.size()).toBe(1); // no full sweep on each access
    store.get("missing", day);
    expect(store.size()).toBe(0);
  });
  it("evicts expired entries before current unlocked ones when full", () => {
    const store = createGuestUsageStore({ capacity: 2, sweepEvery: 100 });
    store.set("current", usage(1, 1), 3);
    store.set("expired", usage(3, 2, "2026-11-11"), 3);
    expect(store.set("new", usage(1, 3), 3)).toBe(true);
    expect(store.get("current", day)).toEqual(usage(1, 1));
    expect(store.get("expired", day)).toBeUndefined();
    expect(store.size()).toBe(2);
  });
  it("evicts the oldest unexhausted entry, never an exhausted one", () => {
    const store = createGuestUsageStore({ capacity: 3 });
    store.set("locked", usage(3, 1), 3);
    store.set("old", usage(2, 2), 3);
    store.set("newer", usage(1, 3), 3);
    expect(store.set("fresh", usage(1, 4), 3)).toBe(true);
    expect(store.get("locked", day)).toEqual(usage(3, 1));
    expect(store.get("old", day)).toBeUndefined();
    expect(store.get("newer", day)).toEqual(usage(1, 3));
  });
  it("fails closed and warns once when every entry is exhausted", () => {
    const warn = vi.fn();
    const store = createGuestUsageStore({ capacity: 1, warn });
    store.set("locked", usage(3, 1), 3);
    expect(store.set("new", usage(1, 2), 3)).toBe(false);
    expect(store.set("other", usage(1, 3), 3)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(store.get("locked", day)).toEqual(usage(3, 1));
    expect(store.set("new", usage(1, 4, "2026-11-13"), 3)).toBe(true);
    expect(store.size()).toBe(1);
  });
});
