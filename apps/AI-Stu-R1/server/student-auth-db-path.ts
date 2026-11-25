import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

function findRepositoryRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

/**
 * Student auth shares the admin SQLite database by default. Relative overrides
 * are anchored to the repository root so filtered workspace process cwd does
 * not silently create a second per-app database.
 */
export function resolveStudentAuthDbPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string {
  const root = findRepositoryRoot(cwd);
  const configured = env.STUDENT_AUTH_DB_PATH || env.SQLITE_PATH || env.DATABASE_URL?.replace(/^file:/, "");
  if (!configured) return join(root, "data", "ai-smartbook-r1.db");
  return isAbsolute(configured) ? resolve(configured) : resolve(root, configured);
}
