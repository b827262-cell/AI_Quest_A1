import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const source = readFileSync(new URL("apiBase.ts", import.meta.url), "utf8");
const apiBasePath = fileURLToPath(new URL("apiBase.ts", import.meta.url));

/**
 * Compile the real apiBase.ts source with the same production-time Vite
 * constant substitution `sites()`/`cloudflare()` builds apply
 * (VITE_ADMIN_API_ORIGIN baked in, import.meta.env.PROD === true), so these
 * tests exercise actual compiled runtime behavior rather than only asserting
 * on source text. This mirrors what a real production build of the shared
 * bundle looks like for every deployment target, chatgpt.site included.
 */
async function loadCompiledResolveAdminApiUrl(): Promise<(path: string) => string> {
  const result = await esbuild.build({
    entryPoints: [apiBasePath],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    define: {
      "import.meta.env.VITE_ADMIN_API_ORIGIN": '"https://admin-api.b827262.org"',
      "import.meta.env.PROD": "true"
    }
  });
  const code = result.outputFiles[0].text;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const mod = (await import(moduleUrl)) as { resolveAdminApiUrl: (path: string) => string };
  return mod.resolveAdminApiUrl;
}

describe("resolveAdminApiUrl same-origin proxy hostnames (source)", () => {
  it("names the chatgpt.site Sites domain in the same-origin allowlist", () => {
    expect(source).toContain('"ai-quest-a1-admin.b827262.chatgpt.site"');
  });

  it("checks window.location.hostname before falling back to VITE_ADMIN_API_ORIGIN", () => {
    const sameOriginCheckIndex = source.indexOf("SAME_ORIGIN_PROXY_HOSTNAMES.has");
    const absoluteUrlIndex = source.indexOf("new URL(path,");
    expect(sameOriginCheckIndex).toBeGreaterThan(-1);
    expect(absoluteUrlIndex).toBeGreaterThan(-1);
    expect(sameOriginCheckIndex).toBeLessThan(absoluteUrlIndex);
  });

  it("guards window access for non-browser evaluation (SSR/build-time safety)", () => {
    expect(source).toContain('typeof window !== "undefined"');
  });

  it("does not disable the existing local-dev relative-path behavior", () => {
    expect(source).toContain("!ADMIN_API_ORIGIN || !import.meta.env.PROD) return path;");
  });
});

describe("resolveAdminApiUrl same-origin proxy hostnames (compiled, production-condition runtime)", () => {
  let resolveAdminApiUrl: (path: string) => string;
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeAll(async () => {
    resolveAdminApiUrl = await loadCompiledResolveAdminApiUrl();
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("returns a relative path on the chatgpt.site Sites hostname even though VITE_ADMIN_API_ORIGIN is baked in", () => {
    (globalThis as { window?: unknown }).window = {
      location: { hostname: "ai-quest-a1-admin.b827262.chatgpt.site" }
    };
    expect(resolveAdminApiUrl("/api/admin/auth/login")).toBe("/api/admin/auth/login");
  });

  it("preserves the existing absolute-origin behavior for a non-chatgpt.site production hostname (no regression)", () => {
    (globalThis as { window?: unknown }).window = { location: { hostname: "admin.b827262.org" } };
    expect(resolveAdminApiUrl("/api/admin/auth/login")).toBe(
      "https://admin-api.b827262.org/api/admin/auth/login"
    );
  });

  it("preserves absolute-origin behavior for any other unrelated hostname (allowlist is not a wildcard)", () => {
    (globalThis as { window?: unknown }).window = { location: { hostname: "some-other-host.example" } };
    expect(resolveAdminApiUrl("/api/admin/auth/login")).toBe(
      "https://admin-api.b827262.org/api/admin/auth/login"
    );
  });

  it("falls back to the absolute origin when window is unavailable (SSR/build-time evaluation), without throwing", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => resolveAdminApiUrl("/api/admin/auth/login")).not.toThrow();
    expect(resolveAdminApiUrl("/api/admin/auth/login")).toBe(
      "https://admin-api.b827262.org/api/admin/auth/login"
    );
  });
});
