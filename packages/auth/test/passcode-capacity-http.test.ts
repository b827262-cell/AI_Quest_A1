import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { createStudentAuthRouter } from "../src/express";
import { createStudentPasscodeThrottle } from "../src/passcode";
import { resolveStudentAuthConfig, type StudentAuthService } from "../src/server";

describe("passcode throttle HTTP responses", () => {
  it("distinguishes capacity exhaustion from a locked account and logs no identifiers", async () => {
    const throttle = createStudentPasscodeThrottle(2);
    for (let i = 0; i < 5; i++) throttle.reserve("127.0.0.1", "locked@example.test");
    const config = resolveStudentAuthConfig({ STUDENT_PASSCODE_LOGIN: "true" });
    const app = express();
    app.use(express.json());
    app.use(createStudentAuthRouter({} as StudentAuthService, config, throttle));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/passcode/login`;
      const send = (email: string) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, passcode: "wrong" }) });
      const capacity = await send("new@example.test");
      expect(capacity.status).toBe(429);
      expect(await capacity.json()).toEqual({ error: "RATE_LIMITED_CAPACITY" });
      expect(warn).toHaveBeenCalledExactlyOnceWith("Student passcode throttle capacity exhausted");
      const locked = await send("locked@example.test");
      expect(locked.status).toBe(429);
      expect(await locked.json()).toEqual({ error: "RATE_LIMITED" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
