import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

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
      .replaceAll("OPENAI_CONFIG", "BLOCKED_LOCAL_SELECTOR_3");
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
      scrubCloudPolyfillSelectors,
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
    resolve: {
      alias: [
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
