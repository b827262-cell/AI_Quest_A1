import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export async function getDb(d1Database?: D1Database) {
  let targetDb = d1Database;
  if (!targetDb) {
    try {
      // Dynamic import to prevent Node.js module loader from crashing in non-workerd environments
      // @ts-ignore
      const cf = await import("cloudflare:workers");
      targetDb = cf?.env?.DB;
    } catch {
      // Running in Node.js test environment or workerd without cloudflare:workers scheme
    }
  }

  if (!targetDb) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(targetDb, { schema });
}

export * from "./schema";
