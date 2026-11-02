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
export function createStudentPasscodeThrottle() {
  const ips = new Map<string, Attempt[]>();
  const emails = new Map<string, Attempt[]>();
  let sequence = 0;
  const windowMs = 15 * 60_000;
  return {
    reserve(ip: string, email: string, now = Date.now()) {
      const account = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
      const keys: Array<[Map<string, Attempt[]>, string, number]> = [[ips, ip || "unknown", 10], [emails, account, 5]];
      const lists = keys.map(([map, key]) => (map.get(key) ?? []).filter((a) => now - a.at < windowMs));
      const until = Math.max(...lists.map((list, index) => list.length >= keys[index]![2] ? list[0]!.at + windowMs : 0));
      if (until > now) return { allowed: false, retryAfter: Math.ceil((until - now) / 1000), finish: (_success: boolean) => {} };
      const attempt = { id: ++sequence, at: now };
      keys.forEach(([map, key], index) => map.set(key, [...lists[index]!, attempt]));
      let done = false;
      return { allowed: true, retryAfter: 0, finish(success: boolean) {
        if (done) return;
        done = true;
        if (success) keys.forEach(([map, key]) => { const remaining = (map.get(key) ?? []).filter((a) => a.id !== attempt.id); if (remaining.length) map.set(key, remaining); else map.delete(key); });
      } };
    }
  };
}
