import { describe, expect, it } from "vitest";
import express from "express";
import { studentClientIp } from "@ai-smartbook/auth/express";
import type { AddressInfo } from "node:net";

describe("student login security boundaries", () => {
  it("trusts forwarded IPs only from loopback and prefers a valid Cloudflare IP", async () => {
    const app = express();
    app.set("trust proxy", "loopback");
    app.get("/", (req, res) => res.json({ ip: studentClientIp(req) }));
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const cf = await fetch(url, { headers: { "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.2" } });
      expect(await cf.json()).toEqual({ ip: "203.0.113.10" });
      const xff = await fetch(url, { headers: { "x-forwarded-for": "198.51.100.2" } });
      expect(await xff.json()).toEqual({ ip: "127.0.0.1" });
      const req = { socket: { remoteAddress: "192.0.2.3" }, ip: "192.0.2.3", header: () => "203.0.113.10" };
      expect(studentClientIp(req as never)).toBe("192.0.2.3");
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it.each(["::1", "::ffff:127.0.0.1"])("trusts Cloudflare from %s and falls back for invalid values", (remote) => {
    const request = (header: string) => ({ socket: { remoteAddress: remote }, ip: "198.51.100.2", header: () => header });
    expect(studentClientIp(request("203.0.113.10") as never)).toBe("203.0.113.10");
    expect(studentClientIp(request("not-an-ip") as never)).toBe("127.0.0.1");
  });
  it("ignores Cloudflare headers from non-loopback addresses", () => {
    const req = { socket: { remoteAddress: "192.0.2.3" }, ip: "192.0.2.3", header: () => "203.0.113.10" };
    expect(studentClientIp(req as never)).toBe("192.0.2.3");
  });

});
