import { describe, expect, it } from "vitest";
import { resolveClientIp } from "../src/express";

function request(remote: string | undefined, headers: Record<string, string>) {
  return { socket: { remoteAddress: remote }, header: (name: string) => headers[name] } as never;
}

describe("admin client IP resolution", () => {
  it("ignores all forwarded headers from a non-loopback socket", () => {
    expect(resolveClientIp(request("192.0.2.1", { "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }))).toEqual({ ip: "192.0.2.1", source: "socket" });
  });
  it.each(["127.0.0.1", "127.42.0.7", "::1", "::ffff:127.0.0.1"])("trusts valid CF IP from %s", (remote) => {
    expect(resolveClientIp(request(remote, { "cf-connecting-ip": "203.0.113.1" }))).toEqual({ ip: "203.0.113.1", source: "cf-connecting-ip" });
  });
  it("falls back to the socket for an invalid CF IP even with other headers", () => {
    expect(resolveClientIp(request("::1", { "cf-connecting-ip": "bad-ip", "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.2" }))).toEqual({ ip: "127.0.0.1", source: "socket" });
  });
  it("does not use XFF or X-Real-IP as fallback", () => {
    expect(resolveClientIp(request("127.0.0.1", { "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.2" }))).toEqual({ ip: "127.0.0.1", source: "socket" });
  });
  it.each(["0:0:0:0:0:ffff:127.0.0.1", "::ffff:7f00:1"])("recognizes mapped loopback %s", (remote) => {
    expect(resolveClientIp(request(remote, { "cf-connecting-ip": "2001:db8::1" }))).toEqual({ ip: "2001:db8::1", source: "cf-connecting-ip" });
    expect(resolveClientIp(request(remote, {}))).toEqual({ ip: "127.0.0.1", source: "socket" });
  });
  it("normalizes a non-loopback mapped socket without trusting its header", () => {
    expect(resolveClientIp(request("::ffff:192.0.2.1", { "cf-connecting-ip": "203.0.113.1" }))).toEqual({ ip: "192.0.2.1", source: "socket" });
  });
  it.each([undefined, ""])("returns unknown for a missing socket %s", (remote) => {
    expect(resolveClientIp(request(remote, { "cf-connecting-ip": "203.0.113.1" }))).toEqual({ ip: null, source: null });
  });
});
