import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const projectRootEnvPath = fileURLToPath(new URL("../../../../.env", import.meta.url));

function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

/** Load the repository-root .env without overriding deployment-injected env. */
export function loadRootEnv(
  envFilePath = projectRootEnvPath,
  target: NodeJS.ProcessEnv = process.env
): { loaded: boolean; path: string; adminTokenConfigured: boolean; credentialEncryptionKeyConfigured: boolean } {
  if (existsSync(envFilePath)) {
    const values = parseEnvFile(readFileSync(envFilePath, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (target[key] === undefined) target[key] = value;
    }
  }
  return {
    loaded: existsSync(envFilePath),
    path: envFilePath,
    adminTokenConfigured: Boolean(target.ADMIN_API_TOKEN?.trim()),
    credentialEncryptionKeyConfigured: Boolean(target.AI_CREDENTIAL_ENCRYPTION_KEY?.trim())
  };
}
