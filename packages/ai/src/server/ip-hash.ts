import { createHmac } from "node:crypto";

/**
 * Server-only one-way IP identifier for quota scoping and risk signalling.
 * The HMAC output is never returned to the browser.
 */
const DEV_HMAC_SECRET = "ai-smartbook-guest-ask-dev-hmac";

export function resolveGuestAskIpHmacSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GUEST_ASK_IP_HMAC_SECRET?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error("GUEST_ASK_IP_HMAC_SECRET must be configured in production");
  }
  return DEV_HMAC_SECRET;
}

/** Domain separation keeps IP HMACs distinct from recovery-token digests. */
export const GUEST_IP_DOMAIN = "guest-ip:";

export function hmacVisitorIp(ip: string, secret: string): string {
  const normalizedIp = ip || "anonymous";
  return createHmac("sha256", secret).update(GUEST_IP_DOMAIN + normalizedIp).digest("hex");
}
