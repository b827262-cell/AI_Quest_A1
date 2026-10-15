/** Cloudflare Worker entry point for the vinext-starter template. */
import type { D1Database } from "@cloudflare/workers-types";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { gateApiRequest } from "../app/api/backend-client";

interface Env {
  // Static-assets binding; only fetch() is used, typed with the DOM Request/Response
  // the rest of this file uses (workers-types' Fetcher has its own, incompatible ones).
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB: D1Database;
  BOOKS_BUCKET?: unknown;
  RELEASE_VALIDATION_SECRET?: string;
  SYNC_IMPORT_SECRET?: string;
  SYNC_MAX_PDF_BYTES?: string;
  // Declared site topology and the deployed commit. See app/api/backend-client.ts.
  GIT_SHA?: string;
  SITE_ROLE?: string;
  SITE_NAME?: string;
  PRIMARY_ORIGIN?: string;
  // Comma-separated administrator allowlist (exact, case-insensitive). Unset
  // means nobody is an administrator. See app/api/auth-helper.ts.
  ADMIN_EMAILS?: string;
  A01_RELAY_KEY_STUDENT?: string;
  A01_RELAY_KEY_STUDENT_PREV?: string;
  A01_RELAY_KEY_ADMIN?: string;
  A01_RELAY_KEY_ADMIN_PREV?: string;
  A01_RELAY_MODE?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    (globalThis as unknown as { BOOKS_BUCKET?: unknown }).BOOKS_BUCKET = env.BOOKS_BUCKET;
    (globalThis as unknown as { DB?: unknown }).DB = env.DB;
    (globalThis as unknown as { RELEASE_VALIDATION_SECRET?: string }).RELEASE_VALIDATION_SECRET =
      env.RELEASE_VALIDATION_SECRET;
    (globalThis as unknown as { SYNC_IMPORT_SECRET?: string }).SYNC_IMPORT_SECRET = env.SYNC_IMPORT_SECRET;
    (globalThis as unknown as { SYNC_MAX_PDF_BYTES?: string }).SYNC_MAX_PDF_BYTES = env.SYNC_MAX_PDF_BYTES;
    const runtimeGlobals = globalThis as unknown as { GIT_SHA?: string; SITE_ROLE?: string; SITE_NAME?: string; PRIMARY_ORIGIN?: string; ADMIN_EMAILS?: string; A01_RELAY_KEY_STUDENT?: string; A01_RELAY_KEY_STUDENT_PREV?: string; A01_RELAY_KEY_ADMIN?: string; A01_RELAY_KEY_ADMIN_PREV?: string; A01_RELAY_MODE?: string };
    runtimeGlobals.GIT_SHA = env.GIT_SHA;
    runtimeGlobals.SITE_ROLE = env.SITE_ROLE;
    runtimeGlobals.SITE_NAME = env.SITE_NAME;
    runtimeGlobals.PRIMARY_ORIGIN = env.PRIMARY_ORIGIN;
    runtimeGlobals.ADMIN_EMAILS = env.ADMIN_EMAILS;
    runtimeGlobals.A01_RELAY_KEY_STUDENT = env.A01_RELAY_KEY_STUDENT;
    runtimeGlobals.A01_RELAY_KEY_STUDENT_PREV = env.A01_RELAY_KEY_STUDENT_PREV;
    runtimeGlobals.A01_RELAY_KEY_ADMIN = env.A01_RELAY_KEY_ADMIN;
    runtimeGlobals.A01_RELAY_KEY_ADMIN_PREV = env.A01_RELAY_KEY_ADMIN_PREV;
    runtimeGlobals.A01_RELAY_MODE = env.A01_RELAY_MODE;
    const url = new URL(request.url);

    // The gate decides what counts as an API request; a second prefix test here would
    // be a second path grammar that /API/ or //api// variants could slip past.
    const gate = gateApiRequest(url.pathname);
    if (gate) return gate;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
