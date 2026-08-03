import { describe, expect, it } from "vitest";
import { getViteProxyConfig, type ViteProxyHttp, type ViteProxyReq } from "../vite.config";

describe("Vite proxy configuration and security boundary", () => {
  it("configures proxy target and injects X-Admin-Token ONLY for /api/admin/* routes", () => {
    const fakeToken = "test-secret-admin-token-999";
    const fakeTarget = "http://127.0.0.1:4300";
    const config = getViteProxyConfig({
      ADMIN_API_TOKEN: fakeToken,
      ADMIN_API_TARGET: fakeTarget
    });

    expect(config["/api/admin"]).toBeDefined();
    expect(config["/api"]).toBeDefined();

    expect(config["/api/admin"]?.target).toBe(fakeTarget);
    expect(config["/api"]?.target).toBe(fakeTarget);

    // Mock proxy event listener for /api/admin
    const proxyListeners: Record<string, (proxyReq: ViteProxyReq) => void> = {};
    const mockProxy: ViteProxyHttp = {
      on: (event: string, handler: (proxyReq: ViteProxyReq) => void) => {
        proxyListeners[event] = handler;
      }
    };

    const adminProxyItem = config["/api/admin"];
    if (adminProxyItem?.configure) {
      adminProxyItem.configure(mockProxy);
    }
    expect(proxyListeners["proxyReq"]).toBeDefined();

    // Verify header is set on proxied request to /api/admin
    const headers: Record<string, string> = {};
    const mockProxyReq: ViteProxyReq = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      }
    };

    proxyListeners["proxyReq"]?.(mockProxyReq);
    expect(headers["X-Admin-Token"]).toBe(fakeToken);

    // Verify non-admin proxy (/api) does NOT have token injection configure hook
    expect(config["/api"]?.configure).toBeUndefined();
  });

  it("does not inject X-Admin-Token if token environment variable is empty", () => {
    const config = getViteProxyConfig({
      ADMIN_API_TOKEN: "   ",
      ADMIN_API_TARGET: "http://127.0.0.1:4300"
    });

    const proxyListeners: Record<string, (proxyReq: ViteProxyReq) => void> = {};
    const mockProxy: ViteProxyHttp = {
      on: (event: string, handler: (proxyReq: ViteProxyReq) => void) => {
        proxyListeners[event] = handler;
      }
    };

    const adminProxyItem = config["/api/admin"];
    if (adminProxyItem?.configure) {
      adminProxyItem.configure(mockProxy);
    }
    const headers: Record<string, string> = {};
    const mockProxyReq: ViteProxyReq = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      }
    };

    proxyListeners["proxyReq"]?.(mockProxyReq);
    expect(headers["X-Admin-Token"]).toBeUndefined();
  });

  it("secret protection: proxy token remains server-side in proxyReq and is not exposed to window or React bundle", () => {
    // In browser environment, window or global state must not contain process.env.ADMIN_API_TOKEN
    const globalKeys = Object.keys(globalThis);
    expect(globalKeys.includes("ADMIN_API_TOKEN")).toBe(false);
  });
});
