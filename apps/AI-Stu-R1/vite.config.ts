import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ["student.b827262.org", "100.76.46.86", "b827262-e500-g9-ws760t.tailc359df.ts.net"],
    proxy: {
      // B3 is the read-only PostgreSQL exam-course boundary. Keep this more
      // specific rule ahead of /api/public so course search never reaches the
      // unrelated admin public API.
      "/api/public/exam-courses": {
        target: process.env.B3_SEARCH_API_TARGET || "http://127.0.0.1:4360",
        changeOrigin: true
      },
      "/api/student": {
        target: process.env.STUDENT_API_TARGET || "http://127.0.0.1:4310",
        changeOrigin: true
      },
      // Read-only appearance settings + uploaded banner/logo images.
      "/api/appearance-settings": {
        target: process.env.ADMIN_API_TARGET || "http://127.0.0.1:4300",
        changeOrigin: true
      },
      "/api/uploads": {
        target: process.env.ADMIN_API_TARGET || "http://127.0.0.1:4300",
        changeOrigin: true
      },
      // Guest ask/feedback + public site-config, served by the admin API.
      "/api/public": {
        target: process.env.ADMIN_API_TARGET || "http://127.0.0.1:4300",
        changeOrigin: true
      },
      // tw-legal-flow institutional flow data (read-only sidecar on port 4350)
      "/api/institutional-flow": {
        target: process.env.FLOW_API_TARGET || "http://127.0.0.1:4350",
        changeOrigin: true
      }
    }
  }
});
