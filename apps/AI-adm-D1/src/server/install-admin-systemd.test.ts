import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "..", "..");
const installer = join(repoRoot, "deploy/scripts/install-admin-systemd.sh");
let testRoot = "";
let binDir = "";
let envFile = "";
let commandLog = "";

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "admin-systemd-install-"));
  binDir = join(testRoot, "bin");
  envFile = join(testRoot, "etc", "admin.env");
  commandLog = join(testRoot, "commands.log");
  spawnSync("mkdir", ["-p", binDir], { encoding: "utf8" });
  writeFileSync(join(binDir, "pnpm"), "#!/usr/bin/env bash\nprintf 'pnpm %s\\n' \"$*\" >> \"$STUB_LOG\"\n");
  writeFileSync(join(binDir, "sudo"), `#!/usr/bin/env bash
printf 'sudo %s\\n' "$*" >> "$STUB_LOG"
if [ "$1" = systemctl ] || [ "$1" = useradd ] || [ "$1" = chown ]; then exit 0; fi
if [ "$1" = cp ] && [ "$3" = /etc/systemd/system/ai-adm-d1.service ]; then exit 0; fi
redirected=()
for argument in "$@"; do
  if [ "$argument" = /etc/ai-quest-a1 ]; then
    redirected+=("$STUB_ENV_DIR")
  elif [ "$argument" = /etc/ai-quest-a1/admin.env ]; then
    redirected+=("$STUB_ENV_FILE")
  else
    redirected+=("$argument")
  fi
done
exec "\${redirected[@]}"
`);
  chmodSync(join(binDir, "pnpm"), 0o755);
  chmodSync(join(binDir, "sudo"), 0o755);
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function runInstaller() {
  return spawnSync("bash", [installer], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      PROJECT_ROOT: repoRoot,
      STUB_ENV_DIR: join(testRoot, "etc"),
      STUB_ENV_FILE: envFile,
      STUB_LOG: commandLog
    }
  });
}

function log(): string {
  try {
    return readFileSync(commandLog, "utf8");
  } catch {
    return "";
  }
}

function writeEnv(values: Partial<Record<string, string>> = {}) {
  spawnSync("mkdir", ["-p", join(testRoot, "etc")], { encoding: "utf8" });
  writeFileSync(envFile, [
    `ADMIN_USERNAME=${values.ADMIN_USERNAME ?? "admin"}`,
    `ADMIN_PASSWORD_HASH=${values.ADMIN_PASSWORD_HASH ?? "hash"}`,
    `AI_CREDENTIAL_ENCRYPTION_KEY=${values.AI_CREDENTIAL_ENCRYPTION_KEY ?? "encryption-key"}`,
    `GUEST_ASK_IP_HMAC_SECRET=${values.GUEST_ASK_IP_HMAC_SECRET ?? "hmac-secret"}`
  ].join("\n"));
}

describe("fresh-install production bootstrap", () => {
  it("DEPLOY-1: exits non-zero when the environment file is missing", () => {
    expect(runInstaller().status).not.toBe(0);
  });

  it("DEPLOY-2: creates a protected template and prints completion instructions", () => {
    const result = runInstaller();
    expect(readFileSync(envFile, "utf8")).toContain("ADMIN_PASSWORD_HASH=");
    expect(result.stderr).toContain("Created production environment template");
    expect(result.stderr).toContain("then rerun this installer");
  });

  it("DEPLOY-3: never invokes systemctl after creating a missing template", () => {
    runInstaller();
    expect(log()).not.toContain("systemctl");
  });

  it("DEPLOY-4: reports every blank required value before systemctl", () => {
    writeEnv({
      ADMIN_USERNAME: "",
      ADMIN_PASSWORD_HASH: "",
      AI_CREDENTIAL_ENCRYPTION_KEY: "",
      GUEST_ASK_IP_HMAC_SECRET: ""
    });
    const result = runInstaller();
    expect(result.status).not.toBe(0);
    for (const name of ["ADMIN_USERNAME", "ADMIN_PASSWORD_HASH", "AI_CREDENTIAL_ENCRYPTION_KEY", "GUEST_ASK_IP_HMAC_SECRET"]) {
      expect(result.stderr).toContain(name);
    }
    expect(log()).not.toContain("systemctl");
  });

  it("DEPLOY-5: rejects a partially configured existing environment", () => {
    writeEnv({ GUEST_ASK_IP_HMAC_SECRET: "''" });
    const result = runInstaller();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GUEST_ASK_IP_HMAC_SECRET");
    expect(log()).not.toContain("systemctl");
  });

  it("DEPLOY-6: enables and starts only after all required values validate", () => {
    writeEnv();
    const result = runInstaller();
    expect(result.status).toBe(0);
    expect(log()).toContain("sudo systemctl daemon-reload");
    expect(log()).toContain("sudo systemctl enable --now ai-adm-d1");
    expect(log()).toContain("sudo systemctl status ai-adm-d1 --no-pager");
  });
});
