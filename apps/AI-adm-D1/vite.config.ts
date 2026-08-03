import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const isDevelopment = mode === "development";

  return {
    plugins: [react()],
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
