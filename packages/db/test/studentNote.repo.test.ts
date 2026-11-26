import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDbHandle, createRepositories, runMigrations, type LearningHistoryRecord } from "../src";

function historyEntry(overrides: Partial<LearningHistoryRecord> = {}): LearningHistoryRecord {
  return {
    id: "entry-1",
    askedAt: "2026-10-20T10:00:00.000Z",
    question: "什麼是重力加速度？",
    category: "auto",
    sourceType: "manual",
    strategy: "google-ai",
    organizedAnswer: "重力加速度約為 9.8 m/s²。",
    syncVersion: 1,
    ...overrides
  };
}

function withRepos(run: (repos: ReturnType<typeof createRepositories>) => void) {
  const directory = mkdtempSync(join(tmpdir(), "ai-quest-student-notes-"));
  const handle = createDbHandle(join(directory, "notes.sqlite"));
  try {
    runMigrations(handle.sqlite);
    run(createRepositories(handle.db));
  } finally {
    handle.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("student note repository", () => {
  it("creates, reads, updates and tombstones notes", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      const created = repo.create("student-a", {
        type: "text",
        title: "課堂筆記",
        content: "自由落體公式",
        tags: ["物理", "力學"],
        bookId: "book-1",
        chapterId: "chapter-1",
        pageNumber: 12
      });
      expect(created.tags).toEqual(["物理", "力學"]);
      expect(created.syncVersion).toBe(1);
      expect(created.deletedAt).toBeNull();

      const updated = repo.update("student-a", created.id, {
        content: "修訂後的內容",
        tags: ["物理"],
        pageNumber: 13
      });
      expect(updated).not.toBeNull();
      expect(updated?.content).toBe("修訂後的內容");
      expect(updated?.tags).toEqual(["物理"]);
      expect(updated?.pageNumber).toBe(13);
      expect(updated?.syncVersion).toBe(2);
      expect(updated?.title).toBe("課堂筆記");

      const tombstoned = repo.tombstone("student-a", created.id);
      expect(tombstoned?.deletedAt).not.toBeNull();
      expect(tombstoned?.syncVersion).toBe(3);

      expect(repo.findById("student-a", created.id)).toBeNull();
      expect(repo.findById("student-a", created.id, true)).not.toBeNull();
      expect(repo.update("student-a", created.id, { title: "x" })).toBeNull();
      expect(repo.tombstone("student-a", created.id)).not.toBeNull();
      expect(repo.list("student-a")).toHaveLength(0);
      expect(repo.list("student-a", { includeDeleted: true })).toHaveLength(1);
    });
  });

  it("creates entryId notes idempotently and revives tombstones", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      const input = { entryId: "manual-entry-1", type: "text" as const, title: "手動筆記", content: "內容" };
      const first = repo.create("student-a", input);
      const retry = repo.create("student-a", { ...input, content: "重試內容" });

      expect(retry.id).toBe(first.id);
      expect(retry.content).toBe(first.content);
      expect(retry.syncVersion).toBe(first.syncVersion);
      expect(repo.list("student-a")).toHaveLength(1);

      const tombstoned = repo.tombstone("student-a", first.id);
      expect(tombstoned?.deletedAt).not.toBeNull();
      const revived = repo.create("student-a", input);

      expect(revived.id).toBe(first.id);
      expect(revived.type).toBe("text");
      expect(revived.deletedAt).toBeNull();
      expect(revived.syncVersion).toBe(tombstoned!.syncVersion + 1);
      expect(repo.list("student-a", { includeDeleted: true })).toHaveLength(1);
      expect(repo.list("student-a")).toHaveLength(1);
    });
  });

  it("rejects a tombstone whose syncVersion is behind the stored version", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      const created = repo.create("student-a", { title: "t", content: "c" });
      const bumped = repo.update("student-a", created.id, { content: "c2" });
      expect(bumped?.syncVersion).toBe(2);
      const stale = repo.tombstone("student-a", created.id, 1);
      expect(stale?.deletedAt).toBeNull();
      expect(stale?.syncVersion).toBe(2);
      const current = repo.tombstone("student-a", created.id, 5);
      expect(current?.deletedAt).not.toBeNull();
      expect(current?.syncVersion).toBe(5);
    });
  });

  it("filters by bookId, orders createdAt DESC and applies offset/limit", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      const first = repo.create("student-a", { title: "第一本", bookId: "book-1" });
      repo.create("student-a", { title: "第二本", bookId: "book-2" });
      repo.create("student-a", { title: "第三本", bookId: "book-1" });

      const bookOne = repo.list("student-a", { bookId: "book-1" });
      expect(bookOne.map((note) => note.title).sort()).toEqual(["第一本", "第三本"]);
      expect(repo.list("student-a", { bookId: "book-missing" })).toHaveLength(0);
      // Same-second ISO timestamps fall back to id ordering; page through them.
      const all = repo.list("student-a");
      expect(all).toHaveLength(3);
      const firstPage = repo.list("student-a", { limit: 2 });
      expect(firstPage).toHaveLength(2);
      for (const note of firstPage) {
        expect(all.map((entry) => entry.id)).toContain(note.id);
      }
      expect(first?.createdAt).toBeTruthy();
    });
  });

  it("filters by exact tags and case-insensitive keywords before pagination", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      repo.create("student-a", {
        title: "ALGEBRA Keyword",
        tags: ["數學"],
        bookId: "book-1"
      });
      repo.create("student-a", {
        title: "閱讀筆記",
        content: "kEyWoRd 在內文",
        tags: ["數學"],
        bookId: "book-1"
      });
      repo.create("student-a", {
        title: "Keyword 練習",
        tags: ["數學", "理科"],
        bookId: "book-1"
      });
      repo.create("student-a", {
        title: "Keyword 單字",
        tags: ["數"],
        bookId: "book-1"
      });
      repo.create("student-a", {
        title: "Keyword 其他書籍",
        tags: ["數學"],
        bookId: "book-2"
      });

      expect(repo.list("student-a", { tag: "數" }).map((note) => note.tags)).toEqual([["數"]]);
      expect(repo.list("student-a", { tag: " 數學 " })).toHaveLength(4);
      expect(repo.list("student-a", { q: "keyword" })).toHaveLength(5);
      expect(repo.list("student-a", { q: "KEYWORD" }).map((note) => note.title)).toContain("閱讀筆記");

      const combined = repo.list("student-a", {
        tag: "數學",
        q: "keyword",
        bookId: "book-1"
      });
      expect(combined).toHaveLength(3);
      expect(repo.list("student-a", {
        tag: "數學",
        q: "keyword",
        bookId: "book-1",
        offset: 1,
        limit: 1
      }).map((note) => note.id)).toEqual(combined.slice(1, 2).map((note) => note.id));
      expect(repo.list("student-a", {
        tag: "數學",
        q: "keyword",
        bookId: "book-1",
        offset: 2,
        limit: 2
      }).map((note) => note.id)).toEqual(combined.slice(2, 4).map((note) => note.id));
      expect(repo.list("student-b", {
        tag: "數學",
        q: "keyword",
        bookId: "book-1"
      })).toHaveLength(0);
    });
  });

  it("isolates students: B cannot read, update or delete A's note", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      const noteOfA = repo.create("student-a", { title: "A 的筆記", content: "機密" });
      expect(repo.findById("student-b", noteOfA.id)).toBeNull();
      expect(repo.findById("student-b", noteOfA.id, true)).toBeNull();
      expect(repo.update("student-b", noteOfA.id, { content: "竄改" })).toBeNull();
      expect(repo.tombstone("student-b", noteOfA.id)).toBeNull();
      expect(repo.list("student-b")).toHaveLength(0);
      const untouched = repo.findById("student-a", noteOfA.id);
      expect(untouched?.content).toBe("機密");
      expect(untouched?.updatedAt).toBe(noteOfA.updatedAt);
    });
  });

  it("imports a history entry into an ai_answer note with provenance", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      const note = repo.fromHistory(
        "student-a",
        historyEntry({ sourceUrl: "https://example.com/a" }),
        { bookId: "book-1", pageNumber: 5, tags: ["物理"] }
      );
      expect(note).toMatchObject({
        type: "ai_answer",
        source: "google-ai-relay",
        sourceDetail: "https://example.com/a",
        title: "什麼是重力加速度？",
        content: "重力加速度約為 9.8 m/s²。",
        bookId: "book-1",
        pageNumber: 5,
        tags: ["物理"],
        entryId: "entry-1",
        syncVersion: 1
      });
    });
  });

  it("falls back through organizedAnswer/answer/rawAnswer/question content", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      const fromRaw = repo.fromHistory("student-a", historyEntry({
        id: "entry-raw",
        organizedAnswer: undefined,
        answer: undefined,
        rawAnswer: "原始回覆"
      }));
      expect(fromRaw.content).toBe("原始回覆");
      const fromQuestion = repo.fromHistory("student-a", historyEntry({
        id: "entry-q",
        organizedAnswer: undefined,
        answer: undefined,
        rawAnswer: undefined
      }));
      expect(fromQuestion.content).toBe("什麼是重力加速度？");
      const fromApi = repo.fromHistory("student-a", historyEntry({ id: "entry-api", strategy: "api" }));
      expect(fromApi.source).toBe("gemini-api");
      const patchNote = repo.fromHistory("student-a", historyEntry({ id: "entry-note" }), { note: "手寫摘要", title: "自訂標題" });
      expect(patchNote.content).toBe("手寫摘要");
      expect(patchNote.title).toBe("自訂標題");
    });
  });

  it("is idempotent: repeated fromHistory calls keep exactly one note", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      const first = repo.fromHistory("student-a", historyEntry());
      const retry = repo.fromHistory("student-a", historyEntry());
      expect(retry.id).toBe(first.id);
      expect(retry.content).toBe(first.content);
      expect(retry.syncVersion).toBe(first.syncVersion);
      expect(repo.findByEntry("student-a", "entry-1")?.id).toBe(first.id);
      expect(repo.list("student-a")).toHaveLength(1);
      // A patch does not bypass idempotency either.
      const patched = repo.fromHistory("student-a", historyEntry(), { note: "更新摘要" });
      expect(patched.id).toBe(first.id);
      expect(patched.content).toBe(first.content);
      expect(repo.list("student-a")).toHaveLength(1);
    });
  });

  it("revives a tombstoned note instead of creating a second row", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      const original = repo.fromHistory("student-a", historyEntry());
      const tombstoned = repo.tombstone("student-a", original.id);
      expect(tombstoned?.deletedAt).not.toBeNull();
      expect(repo.findByEntry("student-a", "entry-1")).toBeNull();
      const revived = repo.fromHistory("student-a", historyEntry());
      expect(revived.id).toBe(original.id);
      expect(revived.deletedAt).toBeNull();
      expect(revived.syncVersion).toBe(tombstoned!.syncVersion + 1);
      expect(repo.list("student-a", { includeDeleted: true })).toHaveLength(1);
      expect(repo.list("student-a")).toHaveLength(1);
    });
  });

  it("keeps history-entry lookups isolated per student", () => {
    withRepos((repos) => {
      const repo = repos.studentNotes;
      const note = repo.fromHistory("student-a", historyEntry());
      expect(repo.findByEntry("student-b", "entry-1")).toBeNull();
      expect(note.studentId).toBe("student-a");
    });
  });

  it("exposes the history repo's read-only findById for the owner", () => {
    withRepos((repos) => {
      const history = repos.studentLearningHistory;
      history.upsertBatch("student-a", [historyEntry()]);
      expect(history.findById("student-a", "entry-1")?.question).toBe("什麼是重力加速度？");
      expect(history.findById("student-b", "entry-1")).toBeUndefined();
    });
  });
});
