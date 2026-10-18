import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDbHandle, createRepositories, runMigrations, type LearningHistoryRecord } from "../src";

function record(overrides: Partial<LearningHistoryRecord> = {}): LearningHistoryRecord {
  return {
    id: "entry-1",
    askedAt: "2026-10-17T10:00:00.000Z",
    question: "什麼是重力加速度？",
    category: "auto",
    sourceType: "manual",
    strategy: "google-ai",
    rawAnswer: "重力加速度是物體受重力時的加速度。",
    organizedAnswer: "重力加速度是物體受重力時的加速度。",
    syncVersion: 1,
    ...overrides
  };
}

function withRepo(run: (repos: ReturnType<typeof createRepositories>) => void) {
  const directory = mkdtempSync(join(tmpdir(), "ai-quest-learning-history-"));
  const handle = createDbHandle(join(directory, "history.sqlite"));
  try {
    runMigrations(handle.sqlite);
    run(createRepositories(handle.db));
  } finally {
    handle.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("student learning history upsert conflicts", () => {
  it("treats an equal-version retry with the same payload as idempotent", () => {
    withRepo((repos) => {
      const repo = repos.studentLearningHistory;
      const first = repo.upsertBatch("student-a", [record()]);
      const retry = repo.upsertBatch("student-a", [record()]);
      expect(first[0].syncVersion).toBe(1);
      expect(retry[0].syncVersion).toBe(1);
      expect(repo.listStudent("student-a")).toHaveLength(1);
      expect(repo.listStudent("student-a")[0].rawAnswer).toBe("重力加速度是物體受重力時的加速度。");
    });
  });

  it("applies a divergent equal-version edit under the next version instead of dropping it", () => {
    withRepo((repos) => {
      const repo = repos.studentLearningHistory;
      repo.upsertBatch("student-a", [record()]);
      const [stored] = repo.upsertBatch("student-a", [record({ rawAnswer: "另一台裝置的修訂", syncVersion: 1 })]);
      expect(stored.syncVersion).toBe(2);
      expect(stored.rawAnswer).toBe("另一台裝置的修訂");
      expect(repo.listStudent("student-a")).toHaveLength(1);
    });
  });

  it("ignores a stale lower-version write but applies a higher one", () => {
    withRepo((repos) => {
      const repo = repos.studentLearningHistory;
      repo.upsertBatch("student-a", [record({ syncVersion: 3 })]);
      const [stale] = repo.upsertBatch("student-a", [record({ rawAnswer: "過期內容", syncVersion: 2 })]);
      expect(stale.syncVersion).toBe(3);
      expect(stale.rawAnswer).toBe("重力加速度是物體受重力時的加速度。");
      const [fresh] = repo.upsertBatch("student-a", [record({ rawAnswer: "較新內容", syncVersion: 4 })]);
      expect(fresh.syncVersion).toBe(4);
      expect(fresh.rawAnswer).toBe("較新內容");
    });
  });

  it("does not resurrect a tombstoned entry with an equal or higher version", () => {
    withRepo((repos) => {
      const repo = repos.studentLearningHistory;
      repo.upsertBatch("student-a", [record({ syncVersion: 1 })]);
      repo.tombstone("student-a", "entry-1", 2);
      const [afterDelete] = repo.upsertBatch("student-a", [record({ syncVersion: 2 })]);
      expect(afterDelete.deletedAt).not.toBeNull();
      const [afterBump] = repo.upsertBatch("student-a", [record({ syncVersion: 3 })]);
      expect(afterBump.deletedAt).not.toBeNull();
      // A tombstone also blanks the payload; a stale re-upload must not refill it,
      // otherwise deleted content comes back into the row even though it stays hidden.
      expect(afterDelete).toMatchObject({ question: "", answer: undefined, rawAnswer: undefined, organizedAnswer: undefined });
      expect(afterBump).toMatchObject({ question: "", answer: undefined, rawAnswer: undefined, organizedAnswer: undefined });
    });
  });
});
