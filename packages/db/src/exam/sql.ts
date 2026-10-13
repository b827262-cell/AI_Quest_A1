/**
 * Minimal structural view of a PostgreSQL driver.
 *
 * A `pg.Client` / `pg.Pool` satisfies this shape without the package depending
 * on an installed driver, which keeps `pnpm test` runnable in a workspace where
 * no PostgreSQL client library is bootstrapped. The driver is resolved lazily by
 * `scripts/exam-b2-postgres.ts` instead.
 */
export interface SqlExecutor {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** A parameterized statement: `$n` placeholders plus the positional values. */
export interface ExamSqlStatement {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * Escapes the metacharacters ILIKE treats specially. Course text contains
 * literal `_` and `%` (e.g. code formats), and an unescaped keyword would turn
 * a substring search into a wildcard pattern.
 */
export function escapeIlikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function chunkExamCourseRows<T>(rows: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size must be a positive integer, received ${String(size)}`);
  }
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}
