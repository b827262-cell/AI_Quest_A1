import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig as {
  project_id: string;
  d1?: string;
  r2?: string;
};

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const cdnBase =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/";

// Exact basenames of ORT wasm assets that resolveId/transform actually
// rewrote to the CDN. Only these are ever allowed to be removed from the
// bundle; anything else is a build error, never a silent purge.
const externalizedOrtWasmFiles = new Set<string>();

const externalizeOrtWasm = {
  name: "externalize-ort-wasm",
  enforce: "pre" as const,
  resolveId(source: string) {
    if (source.includes("ort-wasm") && source.endsWith(".wasm")) {
      const filename = source.split("/").pop();
      if (filename) externalizedOrtWasmFiles.add(filename);
      return { id: `${cdnBase}${filename}`, external: true };
    }
    return null;
  },
  transform(code: string, id: string) {
    if (
      !id.includes("onnxruntime-web") &&
      !id.includes("transformers") &&
      !id.includes("prompt-api-polyfill")
    ) {
      return null;
    }
    if (code.includes("ort-wasm")) {
      return code.replace(
        /\(?\s*new\s+URL\(\s*["']([^"']*ort-wasm[^"']*\.wasm)["']\s*,\s*import\.meta\.url\s*\)\s*\)?(\.href)?/g,
        (_match, fullFilename, hasHref) => {
          const filename = fullFilename.split("/").pop();
          if (filename) externalizedOrtWasmFiles.add(filename);
          const target = `${cdnBase}${filename}`;
          return hasHref ? JSON.stringify(target) : `new URL(${JSON.stringify(target)})`;
        }
      );
    }
    return null;
  },
  // Owner mandate: this hook may only exclude ORT assets that were precisely
  // identified AND externalized to the CDN (exact-basename match against
  // `externalizedOrtWasmFiles`). Any other asset over the size limit must fail
  // the build with its path:bytes — silent purging here would hide files from
  // the downstream package:size-gate forever.
  generateBundle(
    this: { error: (message: string) => void },
    _options: unknown,
    bundle: Record<string, { type: string; source?: string | Uint8Array }>
  ) {
    const OVERSIZE_LIMIT_BYTES = 25_000_000;
    for (const [fileName, chunk] of Object.entries(bundle)) {
      if (chunk.type !== "asset" || chunk.source == null) continue;
      const basename = fileName.split("/").pop() ?? fileName;
      if (externalizedOrtWasmFiles.has(basename)) {
        // Externalized ORT wasm must come from the CDN, never from the bundle.
        delete bundle[fileName];
        continue;
      }
      const bytes =
        typeof chunk.source === "string"
          ? Buffer.byteLength(chunk.source)
          : chunk.source.byteLength;
      if (bytes > OVERSIZE_LIMIT_BYTES) {
        this.error(
          `OVERSIZE_ASSET_NOT_EXTERNALIZED ${fileName}:${bytes} exceeds ${OVERSIZE_LIMIT_BYTES} bytes; failing build instead of silently purging.`
        );
      }
    }
  },
};

// The upstream experimental polyfill ships registry labels for optional cloud
// backends. Auto aliases those implementations to a fail-closed local module;
// scrub their selector labels too, so no cloud configuration can be selected
// from the emitted application bundle.
const scrubCloudPolyfillSelectors = {
  name: "auto-local-polyfill-only",
  transform(code: string, id: string) {
    if (!id.includes("prompt-api-polyfill")) return null;
    return code
      .replaceAll("FIREBASE_CONFIG", "BLOCKED_LOCAL_SELECTOR_1")
      .replaceAll("GEMINI_CONFIG", "BLOCKED_LOCAL_SELECTOR_2")
      .replaceAll("OPENAI_CONFIG", "BLOCKED_LOCAL_SELECTOR_3")
      .replaceAll("WEBLLM_CONFIG", "BLOCKED_LOCAL_SELECTOR_4");
  },
};

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      externalizeOrtWasm,
      scrubCloudPolyfillSelectors,
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
    resolve: {
      conditions: ["onnxruntime-web-use-extern-wasm"],
      alias: [
        {
          find: /^onnxruntime-web\/webgpu$/,
          replacement: new URL("./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs", import.meta.url).pathname,
        },
        {
          find: /^onnxruntime-web\/wasm$/,
          replacement: new URL("./node_modules/onnxruntime-web/dist/ort.wasm.min.mjs", import.meta.url).pathname,
        },
        {
          find: /^onnxruntime-web\/all$/,
          replacement: new URL("./node_modules/onnxruntime-web/dist/ort.all.min.mjs", import.meta.url).pathname,
        },
        {
          find: /^onnxruntime-web$/,
          replacement: new URL("./node_modules/onnxruntime-web/dist/ort.min.mjs", import.meta.url).pathname,
        },
        {
          find: /.*\/backends\/(firebase|gemini|openai|webllm)\.js$/,
          replacement: new URL("./app/blocked-cloud-backend.ts", import.meta.url).pathname,
        },
        {
          find: /^(@google\/genai|openai|firebase(\/.*)?|@mlc-ai\/web-llm)$/,
          replacement: new URL("./app/blocked-cloud-backend.ts", import.meta.url).pathname,
        },
      ],
    },
  };
});
