import { isIP } from "node:net";
import type { Request } from "express";

/** Normalize IPv6 localhost and IPv4-mapped IPv6 to their IPv4 form. */
function normalizeIp(raw: string): string {
  const ip = raw.trim();
  if (ip === "::1") return "127.0.0.1";
  return ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1] ?? ip;
}

/** Only a local tunnel may supply Cloudflare's client IP. */
export function resolveClientIp(req: Request): { ip: string | null; source: string | null } {
  const remote = req.socket?.remoteAddress ?? "";
  const normalized = normalizeIp(remote);
  const loopback = remote === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."));
  if (loopback) {
    const cf = req.header("cf-connecting-ip")?.trim();
    if (cf && isIP(cf)) return { ip: normalizeIp(cf), source: "cf-connecting-ip" };
  }
  return { ip: normalized || null, source: normalized ? "socket" : null };
}
