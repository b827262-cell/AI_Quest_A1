import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "..", "..");
const nginxConf = readFileSync(join(repoRoot, "deploy/nginx/ai-admin-r1.conf"), "utf8");
const systemdUnit = readFileSync(join(repoRoot, "deploy/systemd/ai-adm-d1.service"), "utf8");
const adminEnvExample = readFileSync(join(repoRoot, "deploy/systemd/admin.env.example"), "utf8");

describe("nginx deployment boundary", () => {
  it("limits client body size instead of relying on the 1 MB default", () => {
    expect(nginxConf).toMatch(/client_max_body_size\s+\d+m;/);
  });

  it("never injects or forwards permanent admin credentials", () => {
    expect(nginxConf).toMatch(/proxy_set_header\s+X-Admin-Token\s+"";/);
    expect(nginxConf).toMatch(/proxy_set_header\s+Authorization\s+"";/);
    expect(nginxConf).not.toMatch(/proxy_set_header\s+(?:X-Admin-Token|Authorization)\s+(?!""\s*;)/);
  });
});

describe("systemd deployment boundary", () => {
  it("runs the production bundle, not a dev server", () => {
    expect(systemdUnit).toMatch(/ExecStart=\/usr\/bin\/node\s+\S*dist-server\/admin-api\.mjs/);
    expect(systemdUnit).not.toMatch(/pnpm dev|vite (dev|preview)/);
  });

  it("runs as a dedicated non-root account", () => {
    const user = systemdUnit.match(/^User=(\S+)/m)?.[1];
    expect(user).toBeTruthy();
    expect(user).not.toBe("root");
    expect(systemdUnit).toMatch(/^Group=/m);
  });

  it("documents every production-required variable and no plaintext password", () => {
    for (const required of [
      "NODE_ENV=production",
      "ADMIN_USERNAME=",
      "ADMIN_PASSWORD_HASH=",
      "ADMIN_SESSION_SECURE=true",
      "ADMIN_ALLOWED_ORIGINS=",
      "AI_CREDENTIAL_ENCRYPTION_KEY=",
      "GUEST_ASK_IP_HMAC_SECRET=",
      "SQLITE_PATH="
    ]) {
      expect(adminEnvExample, `missing ${required}`).toContain(required);
    }
    expect(adminEnvExample).not.toMatch(/^ADMIN_PASSWORD=/m);
  });
});
