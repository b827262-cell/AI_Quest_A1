import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const isDevelopment = mode === "development";
  // Temporary compatibility only: while the development proxy is active it
  // may carry the server-side token. This branch is deliberately absent from
  // preview/production configuration and the secret stays in the Vite
  // process; it is never exposed to the browser bundle.
  const env = loadEnv(mode, repoRoot, "");
  const adminToken = (process.env.ADMIN_API_TOKEN || env.ADMIN_API_TOKEN || "").trim();

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5174,
      proxy: isDevelopment ? {
        "/api": {
          target: process.env.ADMIN_API_TARGET || "http://localhost:4300",
          changeOrigin: true,
          configure(proxy) {
            if (!adminToken) {
              console.warn("[admin-web] ADMIN_API_TOKEN is missing; /api/admin requests will return 401");
              return;
            }
            proxy.on("proxyReq", (proxyReq) => {
              if (!proxyReq.getHeader("x-admin-token")) {
                proxyReq.setHeader("x-admin-token", adminToken);
              }
            });
          }
        }
      } : undefined
    }
  };
});
