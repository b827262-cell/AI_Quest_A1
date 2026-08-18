import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { sites } from "@openai/sites-vite-plugin";

process.env.WRANGLER_WRITE_LOGS ??= "false";

export default defineConfig(({ command, mode }) => {
  const isDevelopment = mode === "development";

  return {
    plugins: [react(), ...(command === "build" ? [sites(), cloudflare()] : [])],
    server: {
      host: "0.0.0.0",
      port: 5174,
      proxy: isDevelopment ? {
        "/api": {
          target: process.env.ADMIN_API_TARGET || "http://localhost:4300",
          changeOrigin: true
        }
      } : undefined
    }
  };
});
