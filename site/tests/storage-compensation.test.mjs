import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryR2Bucket,
  restoreStorageObject,
} from "../lib/storage.ts";

const body = new TextEncoder().encode("%PDF-synthetic-compensation");
const snapshot = {
  body,
  httpMetadata: { contentType: "application/pdf" },
  customMetadata: { sha256: "synthetic-sha256" },
};

test("R2 compensation restores bytes and metadata and verifies persistence", async () => {
  const bucket = new InMemoryR2Bucket();
  await restoreStorageObject(bucket, "textbooks/compensation/book.pdf", snapshot);
  const restored = await bucket.get("textbooks/compensation/book.pdf");
  assert.ok(restored);
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), body);
  assert.deepEqual(restored.httpMetadata, snapshot.httpMetadata);
  assert.deepEqual(restored.customMetadata, snapshot.customMetadata);
});

test("R2 compensation does not report success when put silently drops the object", async () => {
  const bucket = {
    async put() {},
    async head() { return null; },
  };
  await assert.rejects(
    restoreStorageObject(bucket, "textbooks/compensation/missing.pdf", snapshot),
    /missing after write/
  );
});
