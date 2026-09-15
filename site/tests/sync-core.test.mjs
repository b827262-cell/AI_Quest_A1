import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, decideSync, stableTargetId } from "../lib/sync-core.ts";

test("sync decision updates only newer versions and conflicts on changed equal versions", () => {
  const current = { sourceSystem: "e500", sourceRecordId: "1", sourceUpdatedAt: "2026-01-01T00:00:00.000Z", syncVersion: 10, checksum: "a" };
  assert.equal(decideSync({ ...current, syncVersion: 11, checksum: "b" }, current), "update");
  assert.equal(decideSync({ ...current }, current), "skip");
  assert.equal(decideSync({ ...current, checksum: "b" }, current), "conflict");
  assert.equal(decideSync({ ...current, syncVersion: 9, checksum: "b" }, current), "skip");
});

test("canonical JSON excludes sensitive keys and target ids are stable", async () => {
  assert.equal(canonicalJson({ password: "x", name: "A", nested: { apiKey: "y", ok: true } }), '{"name":"A","nested":{"ok":true}}');
  assert.equal(stableTargetId("book", "e500", "book/1"), "sync-book-e500-book_1");
});
