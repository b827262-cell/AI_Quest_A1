export type GuestUsage = { day: string; count: number; lastAt: number; lastAttemptAt: number };
export type GuestUsageSaturationEvent = { event: "guest_usage_saturated"; size: number; capacity: number; day: string };
export type GuestUsageStats = { size: number; capacity: number; day: string; busyCount: number; lastSaturatedAt: number | null };
export const DEFAULT_GUEST_USAGE_CAPACITY = 100_000;
export const DEFAULT_SATURATION_WARN_INTERVAL_MS = 5 * 60_000;
const EXHAUSTED_EVICTION_MS = 60 * 60_000;

/** Bounded, process-local guest quota and cooldown state. */
export function createGuestUsageStore(options: {
  capacity?: number;
  sweepEvery?: number;
  warn?: (event: GuestUsageSaturationEvent) => void;
  saturationWarnIntervalMs?: number;
} = {}) {
  const capacity = options.capacity ?? DEFAULT_GUEST_USAGE_CAPACITY;
  const sweepEvery = options.sweepEvery ?? 128;
  const saturationWarnIntervalMs = options.saturationWarnIntervalMs ?? DEFAULT_SATURATION_WARN_INTERVAL_MS;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(sweepEvery) || sweepEvery < 1) {
    throw new RangeError("capacity and sweepEvery must be positive integers");
  }
  if (!Number.isSafeInteger(saturationWarnIntervalMs) || saturationWarnIntervalMs < 0) {
    throw new RangeError("saturationWarnIntervalMs must be a non-negative integer");
  }
  const warn = options.warn ?? ((event: GuestUsageSaturationEvent) => console.warn(JSON.stringify(event)));
  const entries = new Map<string, GuestUsage>();
  let accesses = 0;
  let lastSaturationWarnAt = Number.NEGATIVE_INFINITY;
  let saturated: { day: string; limit: number; until: number } | undefined;
  let busyDay: string | undefined;
  let busyCount = 0;
  let lastSaturatedAt: number | null = null;
  function sweep(day: string) {
    for (const [key, value] of entries) if (value.day !== day) { entries.delete(key); saturated = undefined; }
  }
  function noteSaturation(day: string, now: number) {
    if (busyDay !== day) { busyDay = day; busyCount = 0; }
    busyCount += 1;
    lastSaturatedAt = now;
    if (now - lastSaturationWarnAt >= saturationWarnIntervalMs) {
      lastSaturationWarnAt = now;
      // Only aggregate counters are logged; identity keys (IPs and their HMACs)
      // never leave the store.
      warn({ event: "guest_usage_saturated", size: entries.size, capacity, day });
    }
  }
  function get(key: string, day: string): GuestUsage | undefined {
    if (++accesses % sweepEvery === 0) sweep(day);
    const entry = entries.get(key);
    if (entry && entry.day !== day) { entries.delete(key); saturated = undefined; return undefined; }
    return entry;
  }
  return {
    capacity,
    size() { return entries.size; },
    stats(day: string): GuestUsageStats {
      return {
        size: entries.size,
        capacity,
        day,
        busyCount: busyDay === day ? busyCount : 0,
        lastSaturatedAt
      };
    },
    get,
    touch(key: string, day: string, now: number) {
      const entry = entries.get(key);
      if (entry?.day === day) entry.lastAttemptAt = now;
    },
    consume(key: string, day: string, limit: number, now: number): GuestUsage | undefined {
      const existing = entries.get(key);
      if (limit <= 0 || (existing?.day === day && existing.count >= limit)) return undefined;
      if (!existing && entries.size >= capacity) {
        if (saturated?.day === day && saturated.limit === limit && now < saturated.until) {
          noteSaturation(day, now);
          return undefined;
        }
        sweep(day);
        if (entries.size >= capacity) {
          let unlocked: string | undefined;
          let unlockedAt = Infinity;
          let expiredLock: string | undefined;
          let expiredAt = Infinity;
          let nextEligible = Infinity;
          for (const [candidate, entry] of entries) {
            if (entry.count < limit) {
              if (entry.lastAt < unlockedAt) { unlocked = candidate; unlockedAt = entry.lastAt; }
            } else if (now - entry.lastAttemptAt > EXHAUSTED_EVICTION_MS) {
              if (entry.lastAttemptAt < expiredAt) { expiredLock = candidate; expiredAt = entry.lastAttemptAt; }
            } else nextEligible = Math.min(nextEligible, entry.lastAttemptAt + EXHAUSTED_EVICTION_MS + 1);
          }
          const victim = unlocked ?? expiredLock;
          if (victim === undefined) {
            noteSaturation(day, now);
            saturated = { day, limit, until: nextEligible };
            return undefined;
          }
          entries.delete(victim);
        }
      }
      const previous = existing?.day === day ? existing : undefined;
      const usage = { day, count: (previous?.count ?? 0) + 1, lastAt: now, lastAttemptAt: now };
      entries.set(key, usage);
      saturated = undefined;
      return usage;
    }
  };
}
