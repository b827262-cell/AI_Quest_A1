/**
 * Slot D's only path to Slot B's PostgreSQL table.
 *
 * Two rules, both forced by the owner's fail-safe requirement:
 *   1. Credentials come from the environment and nothing else. This module never
 *      reads a settings row, a file, or a request body for a connection string.
 *   2. Every unavailable outcome is reported, never smoothed over. A missing
 *      `DATABASE_URL`, a missing driver and an unreachable host each return their
 *      own machine code with no executor attached, so the caller cannot write and
 *      therefore cannot claim a success it did not earn.
 *
 * The driver itself is imported by a specifier the bundler cannot fold, so `pg`
 * stays an optional runtime dependency instead of a build-time one; the production
 * server bundle still builds on a machine where no PostgreSQL client is installed.
 */

import type { SqlExecutor } from "@ai-smartbook/db";

export const EXAM_DATABASE_URL_ENV = "DATABASE_URL";
export const EXAM_DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export type ExamDatabaseUnavailableCode =
  | "database_not_configured"
  | "pg_driver_missing"
  | "database_unreachable";

export interface ExamDatabaseHandle {
  executor: SqlExecutor;
  close: () => Promise<void>;
}

export type ExamDatabaseResolution =
  | { available: true; handle: ExamDatabaseHandle }
  | { available: false; code: ExamDatabaseUnavailableCode; message: string };

interface PgQueryResultLike {
  rows: Array<Record<string, unknown>>;
}

interface PgClientLike {
  connect(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<PgQueryResultLike>;
  end(): Promise<void>;
}

interface PgClientModuleLike {
  Client?: new (config: Record<string, unknown>) => PgClientLike;
  default?: { Client?: new (config: Record<string, unknown>) => PgClientLike };
}

export function examDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env[EXAM_DATABASE_URL_ENV]?.trim() ?? "";
}

function connectTimeoutMs(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.EXAM_DB_CONNECT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : EXAM_DEFAULT_CONNECT_TIMEOUT_MS;
}

/**
 * `error.message` from a driver can contain the host and user half of a
 * connection string, so only the transport code is allowed out of this module.
 */
function transportCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_ .-]{1,40}$/.test(code) ? code : "unknown";
}

async function loadPgClient(): Promise<new (config: Record<string, unknown>) => PgClientLike> {
  const moduleName = process.env.EXAM_POSTGRES_DRIVER?.trim() || "pg";
  const imported = (await import(moduleName)) as PgClientModuleLike;
  const Client = imported.Client ?? imported.default?.Client;
  if (typeof Client !== "function") throw new Error("driver module exposes no Client export");
  return Client;
}

export async function resolveExamDatabase(
  env: NodeJS.ProcessEnv = process.env
): Promise<ExamDatabaseResolution> {
  const connectionString = examDatabaseUrl(env);
  if (connectionString === "") {
    return {
      available: false,
      code: "database_not_configured",
      message: `${EXAM_DATABASE_URL_ENV} is not set; no database target exists`
    };
  }

  let Client: new (config: Record<string, unknown>) => PgClientLike;
  try {
    Client = await loadPgClient();
  } catch {
    return { available: false, code: "pg_driver_missing", message: "the PostgreSQL client driver is not installed" };
  }

  const client = new Client({ connectionString, connectionTimeoutMillis: connectTimeoutMs(env) });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (error) {
    await client.end().catch(() => undefined);
    return {
      available: false,
      code: "database_unreachable",
      message: `database connection failed (${transportCode(error)})`
    };
  }

  return {
    available: true,
    handle: {
      executor: {
        async query(text, params) {
          const result = await client.query(text, params === undefined ? undefined : [...params]);
          return { rows: result.rows };
        }
      },
      close: () => client.end()
    }
  };
}
