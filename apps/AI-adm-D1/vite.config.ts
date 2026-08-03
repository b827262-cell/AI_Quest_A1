import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export type ViteProxyReq = {
  setHeader: (name: string, value: string) => void;
};

export type ViteProxyHttp = {
  on: (event: string, handler: (proxyReq: ViteProxyReq) => void) => void;
};

export type ViteProxyConfigItem = {
  target: string;
  changeOrigin: boolean;
  configure?: (proxy: ViteProxyHttp) => void;
};

export function getViteProxyConfig(env: Record<string, string | undefined>): Record<string, ViteProxyConfigItem> {
  const adminTarget = env.ADMIN_API_TARGET || "http://127.0.0.1:4300";
  const adminToken = env.ADMIN_API_TOKEN?.trim();

  return {
    "/api/admin": {
      target: adminTarget,
      changeOrigin: true,
      configure: (proxy: ViteProxyHttp) => {
        proxy.on("proxyReq", (proxyReq: ViteProxyReq) => {
          if (adminToken) {
            proxyReq.setHeader("X-Admin-Token", adminToken);
          }
        });
      }
    },
    "/api": {
      target: adminTarget,
      changeOrigin: true
    }
  };
}

export default defineConfig(({ mode }) => {
  const rootDir = import.meta.dirname ?? path.resolve(".");
  const env = {
    ...loadEnv(mode, path.resolve(rootDir, "../../"), ""),
    ...loadEnv(mode, rootDir, ""),
    ...process.env
  };

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5174,
      proxy: getViteProxyConfig(env)
    }
  };
});
