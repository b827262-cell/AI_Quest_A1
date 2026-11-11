import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
// Fixed, non-secret salt/hash used solely to equalize unknown-account work.
const FAKE_HASH = `scrypt$16384$8$1$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(32).toString("base64url")}`;

export function generateStudentPasscode(): string {
  let value = "";
  while (value.length < 10) {
    for (const byte of randomBytes(16)) {
      if (byte < 256 - (256 % ALPHABET.length)) value += ALPHABET[byte % ALPHABET.length];
      if (value.length === 10) break;
    }
  }
  return `${value.slice(0, 5)}-${value.slice(5)}`;
}

export function hashStudentPasscode(passcode: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passcode, salt, 32, OPTIONS);
  return ["scrypt", OPTIONS.N, OPTIONS.r, OPTIONS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyStudentPasscode(passcode: string, hash?: string): Promise<boolean> {
  const parts = (hash ?? FAKE_HASH).split("$");
  // Hashes written by this service have fixed parameters; invalid records still do fake work.
  const valid = parts.length === 6 && parts[0] === "scrypt" && parts[1] === "16384" && parts[2] === "8" && parts[3] === "1";
  const chosen = valid ? parts : FAKE_HASH.split("$");
  let salt = Buffer.from(chosen[4]!, "base64url");
  let expected = Buffer.from(chosen[5]!, "base64url");
  if (salt.length !== 16 || expected.length !== 32) { salt = Buffer.alloc(16); expected = Buffer.alloc(32); }
  const actual = await new Promise<Buffer>((resolve, reject) => scrypt(passcode, salt, 32, OPTIONS, (error, key) => error ? reject(error) : resolve(key)));
  return Boolean(hash && valid && timingSafeEqual(actual, expected));
}

type Attempt = { id: number; at: number };
type Bucket = { entries: Attempt[]; expiresAt: number };
export function createStudentPasscodeThrottle(maxKeys = 10_000) {
  const capacity = Math.floor(maxKeys / 2);
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("maxKeys must be at least 2");
  const ips = new Map<string, Bucket>();
  const emails = new Map<string, Bucket>();
  let sequence = 0;
  const windowMs = 15 * 60_000;
  return {
    keyCount() { return ips.size + emails.size; },
    reserve(ip: string, email: string, now = Date.now()) {
      const normalizedEmail = email.trim().toLowerCase();
      if (normalizedEmail.length > 320) return { allowed: false, retryAfter: 1, finish: (_success: boolean) => {} };
      const account = createHash("sha256").update(normalizedEmail).digest("hex");
      const keys: Array<[Map<string, Bucket>, string, number]> = [[ips, ip || "unknown", 10], [emails, account, 5]];
      const lists = keys.map(([map, key]) => {
        const bucket = map.get(key);
        if (!bucket) return [];
        if (bucket.expiresAt <= now) { map.delete(key); return []; }
        return bucket.entries.filter((entry) => entry.at + windowMs > now);
      });
      const until = Math.max(...lists.map((list, index) => {
        const limit = keys[index]![2];
        return list.length >= limit ? list[list.length - limit]!.at + windowMs : 0;
      }));
      if (until > now) return { allowed: false, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)), finish: (_success: boolean) => {} };
      // Only search for eviction candidates when a new key needs space. Locked
      // buckets are never evicted, even under sustained capacity pressure.
      const victims = keys.map(([map, key, limit]) => {
        if (map.has(key) || map.size < capacity) return undefined;
        for (const [candidate, bucket] of map) {
          const active = bucket.expiresAt <= now ? [] : bucket.entries.filter((entry) => entry.at + windowMs > now);
          if (active.length < limit) return candidate;
        }
        return null;
      });
      if (victims.includes(null)) return { allowed: false, reason: "capacity" as const, retryAfter: 1, finish: (_success: boolean) => {} };
      const attempt = { id: ++sequence, at: now };
      keys.forEach(([map, key], index) => {
        const victim = victims[index];
        if (victim !== undefined && victim !== null) map.delete(victim);
        map.delete(key);
        map.set(key, { entries: [...lists[index]!, attempt], expiresAt: now + windowMs });
      });
      let done = false;
      return { allowed: true, retryAfter: 0, finish(success: boolean) {
        if (done) return;
        done = true;
        if (success) keys.forEach(([map, key]) => { const bucket = map.get(key); if (!bucket) return; const remaining = bucket.entries.filter((a) => a.id !== attempt.id); map.delete(key); if (remaining.length) map.set(key, { entries: remaining, expiresAt: remaining[remaining.length - 1]!.at + windowMs }); });
      } };
    }
  };
}
