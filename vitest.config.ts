import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // This tree is a frozen UX reference, not a workspace package or shipped
    // application. Its historical test depended on an undeclared React test
    // stack and must not be collected as part of the active monorepo suite.
    exclude: ["legacy/**", "**/node_modules/**", "**/dist/**"]
  }
});
