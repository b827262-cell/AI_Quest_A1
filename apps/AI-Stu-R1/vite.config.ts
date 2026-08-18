import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { sites } from "@openai/sites-vite-plugin";

process.env.WRANGLER_WRITE_LOGS ??= "false";

export default defineConfig(({ command }) => ({
  plugins: [react(), ...(command === "build" ? [sites(), cloudflare()] : [])],
  server: {
    proxy: {
      "/api/student": {
        target: process.env.STUDENT_API_TARGET || process.env.ADMIN_API_TARGET || "http://127.0.0.1:4300",
        changeOrigin: true
      },
      // Read-only appearance settings + uploaded banner/logo images.
      "/api/appearance-settings": {
        target: process.env.STUDENT_API_TARGET || process.env.ADMIN_API_TARGET || "http://127.0.0.1:4300",
        changeOrigin: true
      },
      "/api/uploads": {
        target: process.env.STUDENT_API_TARGET || process.env.ADMIN_API_TARGET || "http://127.0.0.1:4300",
        changeOrigin: true
      },
      // Guest ask/feedback + public site-config, served by the admin API.
      "/api/public": {
        target: process.env.STUDENT_API_TARGET || process.env.ADMIN_API_TARGET || "http://127.0.0.1:4300",
        changeOrigin: true
      },
      // tw-legal-flow institutional flow data (read-only sidecar on port 4350)
      "/api/institutional-flow": {
        target: process.env.FLOW_API_TARGET || "http://127.0.0.1:4350",
        changeOrigin: true
      }
    }
  }
}));
