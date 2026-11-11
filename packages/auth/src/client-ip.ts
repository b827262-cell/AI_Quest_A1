import { isIP } from "node:net";
import type { Request } from "express";

/** Canonicalize loopback and IPv4-mapped IPv6, including expanded and hex forms. */
function normalizeIp(raw: string): string {
  const ip = raw.trim();
  if (isIP(ip) !== 6) return ip;
  if (ip.includes("%")) return ip;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  if (canonical === "::1") return "127.0.0.1";
  const mapped = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!mapped) return ip;
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** A Cloudflare client address is trusted only from a loopback socket. */
export function resolveClientIp(req: Request): { ip: string | null; source: string | null } {
  const socket = normalizeIp(req.socket?.remoteAddress ?? "");
  if (isIP(socket) === 4 && socket.startsWith("127.")) {
    const cf = req.header("cf-connecting-ip")?.trim();
    if (cf && isIP(cf)) return { ip: normalizeIp(cf), source: "cf-connecting-ip" };
  }
  return { ip: socket || null, source: socket ? "socket" : null };
}
