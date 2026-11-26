import { describe, expect, it } from "vitest";
import {
  createStudentNoteFromHistoryInputSchema,
  createStudentNoteInputSchema,
  studentNoteSchema,
  updateStudentNoteInputSchema
} from "./studentNote.schema";

describe("createStudentNoteInputSchema", () => {
  it("accepts a plain text note and applies defaults", () => {
    const result = createStudentNoteInputSchema.safeParse({ content: "第 3 章重點整理" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("text");
      expect(result.data.content).toBe("第 3 章重點整理");
    }
  });

  it("accepts an ai_answer note with tags and a history entry link", () => {
    const result = createStudentNoteInputSchema.safeParse({
      type: "ai_answer",
      title: "梯度下降為什麼會震盪",
      content: "學習率過大時參數會跨過最低點。",
      tags: ["機器學習", "最佳化"],
      entryId: "entry-1",
      bookId: "book-1",
      chapterId: "chapter-2",
      pageNumber: 42
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("ai_answer");
      expect(result.data.tags).toEqual(["機器學習", "最佳化"]);
      expect(result.data.entryId).toBe("entry-1");
    }
  });

  it("accepts a canvas note whose content is empty but canvasData is present", () => {
    const result = createStudentNoteInputSchema.safeParse({
      type: "canvas",
      content: "",
      canvasData: "{\"strokes\":[]}"
    });

    expect(result.success).toBe(true);
  });

  it("accepts null for optional nullable fields", () => {
    const result = createStudentNoteInputSchema.safeParse({
      content: "重點",
      canvasData: null,
      bookId: null,
      chapterId: null,
      pageNumber: null,
      entryId: null
    });

    expect(result.success).toBe(true);
  });

  it("rejects a payload that smuggles studentId in", () => {
    const result = createStudentNoteInputSchema.safeParse({
      content: "偽造筆記",
      studentId: "someone-else"
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const result = createStudentNoteInputSchema.safeParse({
      content: "重點",
      syncVersion: 99,
      deletedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(result.success).toBe(false);
  });

  it("rejects a title longer than 200 characters", () => {
    const result = createStudentNoteInputSchema.safeParse({
      content: "重點",
      title: "a".repeat(201)
    });

    expect(result.success).toBe(false);
  });

  it("accepts a title of exactly 200 characters", () => {
    const result = createStudentNoteInputSchema.safeParse({
      content: "重點",
      title: "a".repeat(200)
    });

    expect(result.success).toBe(true);
  });

  it("rejects content longer than 50,000 characters", () => {
    const result = createStudentNoteInputSchema.safeParse({
      content: "a".repeat(50_001)
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than 20 tags", () => {
    const result = createStudentNoteInputSchema.safeParse({
      content: "重點",
      tags: Array.from({ length: 21 }, (_, i) => `t${i}`)
    });

    expect(result.success).toBe(false);
  });

  it("rejects a tag longer than 24 characters", () => {
    const result = createStudentNoteInputSchema.safeParse({
      content: "重點",
      tags: ["a".repeat(25)]
    });

    expect(result.success).toBe(false);
  });

  it("rejects empty or whitespace-only content for non-canvas notes", () => {
    expect(createStudentNoteInputSchema.safeParse({}).success).toBe(false);
    expect(createStudentNoteInputSchema.safeParse({ content: "" }).success).toBe(false);
    expect(createStudentNoteInputSchema.safeParse({ content: "   \n\t " }).success).toBe(false);
    expect(
      createStudentNoteInputSchema.safeParse({ type: "ai_answer", content: "  " }).success
    ).toBe(false);
  });

  it("rejects a canvas note without canvasData", () => {
    expect(createStudentNoteInputSchema.safeParse({ type: "canvas" }).success).toBe(false);
    expect(
      createStudentNoteInputSchema.safeParse({ type: "canvas", canvasData: "" }).success
    ).toBe(false);
    expect(
      createStudentNoteInputSchema.safeParse({ type: "canvas", canvasData: null }).success
    ).toBe(false);
  });

  it("rejects an unsupported note type", () => {
    expect(
      createStudentNoteInputSchema.safeParse({ content: "重點", type: "pdf" }).success
    ).toBe(false);
  });

  it("rejects a non-positive or out-of-range page number", () => {
    expect(
      createStudentNoteInputSchema.safeParse({ content: "重點", pageNumber: 0 }).success
    ).toBe(false);
    expect(
      createStudentNoteInputSchema.safeParse({ content: "重點", pageNumber: 100_001 }).success
    ).toBe(false);
    expect(
      createStudentNoteInputSchema.safeParse({ content: "重點", pageNumber: 1.5 }).success
    ).toBe(false);
  });
});

describe("updateStudentNoteInputSchema", () => {
  it("accepts a partial update", () => {
    const result = updateStudentNoteInputSchema.safeParse({ title: "新標題" });

    expect(result.success).toBe(true);
  });

  it("accepts clearing nullable fields", () => {
    const result = updateStudentNoteInputSchema.safeParse({
      canvasData: null,
      chapterId: null,
      pageNumber: null
    });

    expect(result.success).toBe(true);
  });

  it("rejects studentId and unknown fields", () => {
    expect(updateStudentNoteInputSchema.safeParse({ studentId: "other" }).success).toBe(false);
    expect(updateStudentNoteInputSchema.safeParse({ source: "gemini-api" }).success).toBe(false);
  });

  it("rejects oversized title, content and tags", () => {
    expect(updateStudentNoteInputSchema.safeParse({ title: "a".repeat(201) }).success).toBe(false);
    expect(
      updateStudentNoteInputSchema.safeParse({ content: "a".repeat(50_001) }).success
    ).toBe(false);
    expect(
      updateStudentNoteInputSchema.safeParse({
        tags: Array.from({ length: 21 }, (_, i) => `t${i}`)
      }).success
    ).toBe(false);
    expect(updateStudentNoteInputSchema.safeParse({ tags: ["a".repeat(25)] }).success).toBe(false);
  });
});

describe("createStudentNoteFromHistoryInputSchema", () => {
  it("accepts a minimal history conversion body", () => {
    const result = createStudentNoteFromHistoryInputSchema.safeParse({ entryId: "entry-1" });

    expect(result.success).toBe(true);
  });

  it("accepts optional title, note, tags and book metadata", () => {
    const result = createStudentNoteFromHistoryInputSchema.safeParse({
      entryId: "entry-1",
      title: "光合作用",
      note: "補充：光反應在類囊體",
      tags: ["生物"],
      bookId: "book-1",
      chapterId: "chapter-3",
      pageNumber: 12
    });

    expect(result.success).toBe(true);
  });

  it("rejects an empty entryId", () => {
    expect(createStudentNoteFromHistoryInputSchema.safeParse({ entryId: "" }).success).toBe(false);
  });

  it("rejects a missing entryId", () => {
    expect(createStudentNoteFromHistoryInputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects studentId and unknown fields", () => {
    expect(
      createStudentNoteFromHistoryInputSchema.safeParse({
        entryId: "entry-1",
        studentId: "other"
      }).success
    ).toBe(false);
  });

  it("rejects oversized fields", () => {
    expect(
      createStudentNoteFromHistoryInputSchema.safeParse({
        entryId: "entry-1",
        note: "a".repeat(50_001)
      }).success
    ).toBe(false);
    expect(
      createStudentNoteFromHistoryInputSchema.safeParse({
        entryId: "entry-1",
        title: "a".repeat(201)
      }).success
    ).toBe(false);
  });
});

describe("studentNoteSchema", () => {
  it("parses a full persisted row", () => {
    const result = studentNoteSchema.safeParse({
      id: "note-1",
      studentId: "student-1",
      entryId: "entry-1",
      bookId: "book-1",
      chapterId: "chapter-2",
      pageNumber: 42,
      type: "ai_answer",
      title: "梯度下降",
      content: "學習率過大時會震盪。",
      canvasData: null,
      tags: ["機器學習"],
      source: "google-ai-relay",
      sourceDetail: "https://example.com/entry-1",
      createdAt: "2026-11-26T00:00:00.000Z",
      updatedAt: "2026-11-26T00:00:00.000Z",
      deletedAt: null,
      syncVersion: 1
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe("ai_answer");
  });

  it("rejects an unsupported source", () => {
    const result = studentNoteSchema.safeParse({
      id: "note-1",
      studentId: "student-1",
      entryId: null,
      bookId: null,
      chapterId: null,
      pageNumber: null,
      type: "text",
      title: "",
      content: "重點",
      canvasData: null,
      tags: [],
      source: "openai",
      sourceDetail: null,
      createdAt: "2026-11-26T00:00:00.000Z",
      updatedAt: "2026-11-26T00:00:00.000Z",
      deletedAt: null,
      syncVersion: 1
    });

    expect(result.success).toBe(false);
  });

  it("rejects a syncVersion below 1", () => {
    const result = studentNoteSchema.safeParse({
      id: "note-1",
      studentId: "student-1",
      entryId: null,
      bookId: null,
      chapterId: null,
      pageNumber: null,
      type: "text",
      title: "",
      content: "重點",
      canvasData: null,
      tags: [],
      source: "manual",
      sourceDetail: null,
      createdAt: "2026-11-26T00:00:00.000Z",
      updatedAt: "2026-11-26T00:00:00.000Z",
      deletedAt: null,
      syncVersion: 0
    });

    expect(result.success).toBe(false);
  });
});
