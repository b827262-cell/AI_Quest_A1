import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlExecutor } from "./sql";

export interface ExamMigrationFile {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
}

function defaultMigrationsDirectory(): string {
  try {
    return fileURLToPath(new URL("../../postgres/migrations/", import.meta.url));
  } catch {
    return "";
  }
}

const MIGRATION_NAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export function examMigrationsDirectory(): string {
  return defaultMigrationsDirectory();
}

/**
 * Migration files are the single source of the DDL: they are read verbatim at
 * runtime so the applied schema can never drift from the reviewed `.sql` file.
 * Names sort lexicographically, which is why versions are zero-padded.
 */
export function loadExamMigrations(
  directory: string = examMigrationsDirectory()
): ExamMigrationFile[] {
  if (!directory || !existsSync(directory)) {
    throw new Error(`exam migration directory not found: ${directory}`);
  }
  return readdirSync(directory)
    .map((name) => ({ name, match: MIGRATION_NAME_PATTERN.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, match }) => ({
      version: match[1],
      name,
      sql: readFileSync(join(directory, name), "utf8")
    }));
}

/**
 * Each file is submitted as one statement string. The DDL files carry their own
 * BEGIN/COMMIT and take no parameters, which is exactly the case the PostgreSQL
 * simple-query protocol allows to be sent multi-statement; the repository layer
 * keeps runtime SQL parameterized and single-statement.
 */
export async function applyExamMigrations(
  executor: SqlExecutor,
  directory?: string
): Promise<string[]> {
  const applied: string[] = [];
  for (const migration of loadExamMigrations(directory)) {
    await executor.query(migration.sql);
    applied.push(migration.version);
  }
  return applied;
}
