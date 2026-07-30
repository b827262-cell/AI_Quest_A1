import { createHmac, randomBytes } from "node:crypto";

/** Server-only recovery token helpers; raw tokens never enter diagnostics. */
export const GUEST_RECOVERY_DOMAIN = "guest-recovery:";

export function generateRecoveryToken(): string {
  return randomBytes(32).toString("hex");
}

export function digestRecoveryToken(token: string, secret: string): string {
  if (!token) throw new Error("recovery token is required");
  return createHmac("sha256", secret).update(GUEST_RECOVERY_DOMAIN + token).digest("hex");
}

export function safeEqualDigest(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
