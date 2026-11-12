export type GuestUsage = { day: string; count: number; lastAt: number };

/** Bounded, process-local guest quota and cooldown state. */
export function createGuestUsageStore(options: {
  capacity?: number;
  sweepEvery?: number;
  warn?: () => void;
} = {}) {
  const capacity = options.capacity ?? 10_000;
  const sweepEvery = options.sweepEvery ?? 128;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(sweepEvery) || sweepEvery < 1) {
    throw new RangeError("capacity and sweepEvery must be positive integers");
  }
  const warn = options.warn ?? (() => console.warn("Guest usage capacity exhausted; refusing new identities"));
  const entries = new Map<string, GuestUsage>();
  let accesses = 0;
  let warned = false;
  let saturated: { day: string; dailyLimit: number } | undefined;
  function sweep(day: string) {
    for (const [key, value] of entries) if (value.day !== day) entries.delete(key);
  }
  return {
    size() { return entries.size; },
    get(key: string, day: string): GuestUsage | undefined {
      if (++accesses % sweepEvery === 0) sweep(day);
      const entry = entries.get(key);
      if (entry && entry.day !== day) { entries.delete(key); return undefined; }
      return entry;
    },
    set(key: string, usage: GuestUsage, dailyLimit: number): boolean {
      if (!entries.has(key) && entries.size >= capacity) {
        if (saturated?.day === usage.day && saturated.dailyLimit === dailyLimit) return false;
        sweep(usage.day);
        if (entries.size >= capacity) {
          let oldest: string | undefined;
          let oldestTime = Infinity;
          for (const [candidate, entry] of entries) {
            if (entry.count < dailyLimit && entry.lastAt < oldestTime) {
              oldest = candidate;
              oldestTime = entry.lastAt;
            }
          }
          if (oldest === undefined) {
            if (!warned) { warn(); warned = true; }
            saturated = { day: usage.day, dailyLimit };
            return false;
          }
          entries.delete(oldest);
        }
      }
      entries.set(key, usage);
      saturated = undefined;
      warned = false;
      return true;
    }
  };
}
