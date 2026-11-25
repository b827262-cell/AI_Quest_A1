import { eq, like } from "drizzle-orm";
import type { Db } from "../client";
import { appSettings } from "../schema";
import { nowIso } from "./util";

/** Generic key-value settings store (JSON values held as text). */
export function makeSettingsRepo(db: Db) {
  return {
    get(key: string): string | null {
      const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
      return row ? row.value : null;
    },

    set(key: string, value: string): void {
      const ts = nowIso();
      db.insert(appSettings)
        .values({ key, value, updatedAt: ts })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: ts } })
        .run();
    },

    /** All rows whose key starts with `prefix`. Returns { key, value, updatedAt }. */
    listByPrefix(prefix: string): Array<{ key: string; value: string; updatedAt: string }> {
      return db
        .select()
        .from(appSettings)
        .where(like(appSettings.key, `${prefix}%`))
        .all();
    }
  };
}

export type SettingsRepo = ReturnType<typeof makeSettingsRepo>;
