import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { schema } from "./schema";

/**
 * Walk up from `start` to find the monorepo root (the directory that holds
 * pnpm-workspace.yaml). This keeps the default DB path identical no matter
 * which package's cwd a process runs from (db migrate/seed vs admin server).
 */
function findRepoRoot(start: string): string {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start; // reached filesystem root; fall back
    dir = parent;
  }
}

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
}

let cached: DbHandle | null = null;

/**
 * Resolve the SQLite file path. An explicit `SQLITE_PATH` / `DATABASE_URL`
 * always wins; otherwise the path is anchored to the monorepo root so that
 * migrate, seed and the admin server all use the same `data/` file.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const explicit =
    env.SQLITE_PATH || (env.DATABASE_URL ? env.DATABASE_URL.replace(/^file:/, "") : "");
  const repoRoot = findRepoRoot(cwd);
  if (explicit) return isAbsolute(explicit) ? resolve(explicit) : resolve(repoRoot, explicit);
  return join(repoRoot, "data", "ai-smartbook-r1.db");
}

export function createDbHandle(dbPath = resolveDbPath()): DbHandle {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/** Shared singleton handle for the default database path. */
export function getDb(): DbHandle {
  if (!cached) {
    cached = createDbHandle();
  }
  return cached;
}
