import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
class TestMockR2Bucket {
  constructor() {
    this.objects = new Map();
    this.failDelete = false;
    this.dropPut = false;
  }

  async put(key, value, options) {
    let bytes;
    if (value instanceof Uint8Array) {
      bytes = value;
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else if (typeof value === "string") {
      bytes = new TextEncoder().encode(value);
    } else if (value && typeof value.arrayBuffer === "function") {
      bytes = new Uint8Array(await value.arrayBuffer());
    } else {
      bytes = new Uint8Array(0);
    }
    const etag = `mock-etag-${Date.now()}`;
    if (!this.dropPut) {
      this.objects.set(key, {
        body: bytes,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
        etag,
      });
    }
    return {
      key,
      size: bytes.length,
      etag,
      httpEtag: `"${etag}"`,
    };
  }

  async get(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      key,
      size: item.body.length,
      etag: item.etag,
      httpEtag: `"${item.etag}"`,
      httpMetadata: item.httpMetadata,
      customMetadata: item.customMetadata,
      body: new Response(item.body).body,
      arrayBuffer: async () => item.body.buffer,
    };
  }

  async head(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      key,
      size: item.body.length,
      etag: item.etag,
      httpEtag: `"${item.etag}"`,
      httpMetadata: item.httpMetadata,
      customMetadata: item.customMetadata,
    };
  }

  async delete(key) {
    if (this.failDelete) throw new Error("synthetic R2 delete failure");
    this.objects.delete(key);
  }
}

async function sha256Hex(buffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYNTHETIC_PDF_PATH = path.join(__dirname, "..", "fixtures", "assets", "synthetic-test-book.pdf");
const SYNTHETIC_PDF_BYTES = fs.readFileSync(SYNTHETIC_PDF_PATH);

async function requestWorker(pathname, options = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  const req = new Request(`http://localhost${pathname}`, {
    headers: {
      ...(options.headers ?? {}),
    },
    method: options.method ?? "GET",
    body: options.body,
  });

  return worker.fetch(
    req,
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DB: options.db,
      BOOKS_BUCKET: options.booksBucket,
      RELEASE_VALIDATION_SECRET: options.releaseValidationSecret,
    },
    { waitUntil() {}, passThroughOnException() {} }
  );
}

test("Phase 3D: Synthetic PDF fixture integrity and SHA-256 hash", async () => {
  assert.equal(SYNTHETIC_PDF_BYTES.length, 476);
  const header = String.fromCharCode(...SYNTHETIC_PDF_BYTES.slice(0, 5));
  assert.equal(header, "%PDF-");

  const sha = await sha256Hex(new Uint8Array(SYNTHETIC_PDF_BYTES));
  assert.equal(sha, "170e2df4e4f324c124cb9d12c1de469277498647116fb7c3fd98a73af47bc736");
});

test("Phase 3D: GET /api/health exposes R2 binding and BOOKS_BUCKET identifier", async () => {
  const res = await requestWorker("/api/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.d1, "bound");
  assert.equal(data.r2, "bound");
  assert.equal(data.storage, "r2");
  assert.equal(data.sharedR2Bucket, "BOOKS_BUCKET");
  assert.equal(data.sharedR2Project, "appgprj_6aa80235182c8191a876361138ecbc36");
});

test("Phase 3D: Admin textbook upload auth matrix (401 Guest, 403 Student, 201 Admin)", async () => {
  const testBookId = `book-test-auth-${Date.now()}`;
  const mockBucket = new TestMockR2Bucket();

  // 1. Unauthenticated / Guest upload -> 401
  const guestRes = await requestWorker(`/api/admin/books/upload?id=${testBookId}`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
    },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: mockBucket,
  });
  assert.equal(guestRes.status, 401);
  const guestData = await guestRes.json();
  assert.match(guestData.error, /admin authentication required/);

  // 2. Student token upload -> 403
  const studentRes = await requestWorker(`/api/admin/books/upload?id=${testBookId}`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "oai-authenticated-user-id": "student-synth-001",
      "oai-authenticated-user-email": "student.alice@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "student",
    },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: mockBucket,
  });
  assert.equal(studentRes.status, 403);
  const studentData = await studentRes.json();
  assert.match(studentData.error, /admin permission required/);

  // 3. Admin upload -> 201 Created
  const adminRes = await requestWorker(`/api/admin/books/upload?id=${testBookId}&title=${encodeURIComponent("計算機系統導論 (Synthetic)")}`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "oai-authenticated-user-id": "admin-synth-001",
      "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: mockBucket,
  });
  assert.equal(adminRes.status, 201);
  const adminData = await adminRes.json();
  assert.equal(adminData.success, true);
  assert.equal(adminData.book.id, testBookId);
  assert.equal(adminData.book.byteSize, 476);
  assert.equal(adminData.book.sha256, "170e2df4e4f324c124cb9d12c1de469277498647116fb7c3fd98a73af47bc736");
  assert.equal(adminData.book.storageState, "active");
});

test("Phase 3D: Admin upload invalid file returns 400 invalid_pdf", async () => {
  const invalidRes = await requestWorker(`/api/admin/books/upload?id=book-bad-file`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "oai-authenticated-user-id": "admin-synth-001",
      "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
    body: new TextEncoder().encode("This is clearly not a PDF file!"),
  });
  assert.equal(invalidRes.status, 400);
  const data = await invalidRes.json();
  assert.equal(data.error, "invalid_pdf");
});

test("Phase 3D: Empty and oversized PDF uploads are rejected before storage", async () => {
  const mockBucket = new TestMockR2Bucket();
  const authHeaders = {
    "content-type": "application/pdf",
    "oai-authenticated-user-id": "admin-synth-001",
    "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
    "oai-authenticated-user-role": "admin",
  };

  const empty = await requestWorker(`/api/admin/books/upload?id=book-empty-${Date.now()}`, {
    method: "POST",
    headers: authHeaders,
    body: new Uint8Array(),
    booksBucket: mockBucket,
  });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).message, /0 bytes/i);

  const oversizedBytes = new Uint8Array(15 * 1024 * 1024 + 1);
  oversizedBytes.set(new TextEncoder().encode("%PDF-"));
  const oversized = await requestWorker(`/api/admin/books/upload?id=book-large-${Date.now()}`, {
    method: "POST",
    headers: authHeaders,
    body: oversizedBytes,
    booksBucket: mockBucket,
  });
  assert.equal(oversized.status, 400);
  assert.match((await oversized.json()).message, /exceeds allowed limit/i);
  assert.equal(mockBucket.objects.size, 0);
});

test("Phase 3D: Multipart and JSON base64 transports require and preserve PDF bytes", async () => {
  const authHeaders = {
    "oai-authenticated-user-id": "admin-synth-001",
    "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
    "oai-authenticated-user-role": "admin",
  };

  const multipartBucket = new TestMockR2Bucket();
  const form = new FormData();
  form.set("id", `book-multipart-${Date.now()}`);
  form.set("title", "Synthetic multipart PDF");
  form.set("file", new File([SYNTHETIC_PDF_BYTES], "fixture.pdf", { type: "application/pdf" }));
  const multipart = await requestWorker("/api/admin/books/upload", {
    method: "POST",
    headers: authHeaders,
    body: form,
    booksBucket: multipartBucket,
  });
  assert.equal(multipart.status, 201);
  assert.equal((await multipart.json()).book.sha256, await sha256Hex(SYNTHETIC_PDF_BYTES));

  const jsonBucket = new TestMockR2Bucket();
  const json = await requestWorker("/api/admin/books/upload", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      id: `book-json-${Date.now()}`,
      title: "Synthetic JSON PDF",
      contentType: "application/pdf",
      pdfBase64: SYNTHETIC_PDF_BYTES.toString("base64"),
    }),
    booksBucket: jsonBucket,
  });
  assert.equal(json.status, 201);
  assert.equal((await json.json()).book.sha256, await sha256Hex(SYNTHETIC_PDF_BYTES));
});

test("Phase 3D: Client book IDs cannot create traversing object keys", async () => {
  const mockBucket = new TestMockR2Bucket();
  const res = await requestWorker("/api/admin/books/upload?id=..%2F..%2F", {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "oai-authenticated-user-id": "admin-synth-001",
      "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: mockBucket,
  });
  assert.equal(res.status, 201);
  const objectKey = (await res.json()).book.objectKey;
  assert.match(objectKey, /^textbooks\/unknown\/\d+-[a-f0-9]{32}\.pdf$/);
  assert.doesNotMatch(objectKey, /\.\.|\/\.\//);
});

test("Phase 3D: Admin upload rejects a PDF body with a non-PDF media type", async () => {
  const mediaTypeRes = await requestWorker(`/api/admin/books/upload?id=book-bad-media-type`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "oai-authenticated-user-id": "admin-synth-001",
      "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: new TestMockR2Bucket(),
  });
  assert.equal(mediaTypeRes.status, 415);
  const data = await mediaTypeRes.json();
  assert.equal(data.error, "unsupported_media_type");
});

test("Phase 3D: Upload verifies R2 persistence before creating metadata", async () => {
  const mockBucket = new TestMockR2Bucket();
  mockBucket.dropPut = true;
  const res = await requestWorker(`/api/admin/books/upload?id=book-dropped-put-${Date.now()}`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "oai-authenticated-user-id": "admin-synth-001",
      "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: mockBucket,
  });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "r2_put_failed");
});

test("Phase 3D: Reusing a book ID is rejected without orphaning its original R2 object", async () => {
  const bookId = `book-duplicate-${Date.now().toString(36)}`;
  const mockBucket = new TestMockR2Bucket();
  const options = {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "oai-authenticated-user-id": "admin-synth-001",
      "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: mockBucket,
  };

  const first = await requestWorker(`/api/admin/books/upload?id=${bookId}`, options);
  assert.equal(first.status, 201);
  const firstBook = (await first.json()).book;

  const second = await requestWorker(`/api/admin/books/upload?id=${bookId}`, options);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, "book_already_exists");
  assert.equal(mockBucket.objects.size, 1);
  assert.ok(await mockBucket.head(firstBook.objectKey));
});

test("Phase 3D: Concurrent uploads for one book ID leave exactly one active object", async () => {
  const bookId = `book-concurrent-${Date.now().toString(36)}`;
  const mockBucket = new TestMockR2Bucket();
  const upload = () => requestWorker(`/api/admin/books/upload?id=${bookId}`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "oai-authenticated-user-id": "admin-synth-001",
      "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: mockBucket,
  });

  const responses = await Promise.all([upload(), upload()]);
  assert.deepEqual(responses.map((res) => res.status).sort(), [201, 409]);
  const payloads = await Promise.all(responses.map((res) => res.json()));
  const conflict = payloads.find((payload) => payload.error === "book_already_exists");
  assert.ok(conflict);
  if ("r2Compensated" in conflict) assert.equal(conflict.r2Compensated, true);
  assert.equal(mockBucket.objects.size, 1);
});

test("Phase 3D: Full textbook lifecycle (Upload -> List -> Detail -> Content Stream -> Delete -> Idempotent Delete -> 404)", async () => {
  const bookId = `book-lifecycle-${Date.now().toString(36)}`;
  const mockBucket = new TestMockR2Bucket();

  // 1. Admin Upload
  const uploadRes = await requestWorker(`/api/admin/books/upload?id=${bookId}&title=作業系統核心與實作`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "oai-authenticated-user-id": "admin-synth-001",
      "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: mockBucket,
  });
  assert.equal(uploadRes.status, 201);
  const uploadData = await uploadRes.json();
  assert.equal(uploadData.book.id, bookId);
  assert.ok(uploadData.book.objectKey.startsWith(`textbooks/${bookId}/`));
  const objectKey = uploadData.book.objectKey;

  // 2. Student List Books -> Should contain newly uploaded book
  const listRes = await requestWorker("/api/student/books", {
    booksBucket: mockBucket,
  });
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.ok(Array.isArray(listData.books));
  const foundBook = listData.books.find((b) => b.id === bookId);
  assert.ok(foundBook, "Uploaded book must appear in student books list");
  assert.equal(foundBook.byteSize, 476);

  // 3. Student Book Detail
  const detailRes = await requestWorker(`/api/student/books/${bookId}`, {
    booksBucket: mockBucket,
  });
  assert.equal(detailRes.status, 200);
  const detailData = await detailRes.json();
  assert.equal(detailData.book.id, bookId);
  assert.equal(detailData.book.sha256, "170e2df4e4f324c124cb9d12c1de469277498647116fb7c3fd98a73af47bc736");

  // 4. Student Content Stream (Download)
  const contentRes = await requestWorker(`/api/student/books/${bookId}/content`, {
    booksBucket: mockBucket,
  });
  assert.equal(contentRes.status, 200);
  assert.equal(contentRes.headers.get("content-type"), "application/pdf");
  const contentBytes = new Uint8Array(await contentRes.arrayBuffer());
  assert.equal(contentBytes.length, 476);
  const streamedSha = await sha256Hex(contentBytes);
  assert.equal(streamedSha, "170e2df4e4f324c124cb9d12c1de469277498647116fb7c3fd98a73af47bc736");

  // 5. Admin Delete
  const deleteRes = await requestWorker(`/api/admin/books/${bookId}`, {
    method: "DELETE",
    headers: {
      "oai-authenticated-user-id": "admin-synth-001",
      "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
    booksBucket: mockBucket,
  });
  assert.equal(deleteRes.status, 200);
  const deleteData = await deleteRes.json();
  assert.equal(deleteData.deleted, true);
  assert.equal(deleteData.storageState, "deleted");
  assert.equal(await mockBucket.head(objectKey), null, "R2 object must be physically absent");

  // 6. Idempotent Second Delete -> Safe 200
  const secondDeleteRes = await requestWorker(`/api/admin/books/${bookId}`, {
    method: "DELETE",
    headers: {
      "oai-authenticated-user-id": "admin-synth-001",
      "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
    booksBucket: mockBucket,
  });
  assert.equal(secondDeleteRes.status, 200);
  const secondDeleteData = await secondDeleteRes.json();
  assert.equal(secondDeleteData.alreadyDeleted, true);

  // 7. Post-delete Student Content Stream -> 404
  const postDeleteContentRes = await requestWorker(`/api/student/books/${bookId}/content`, {
    booksBucket: mockBucket,
  });
  assert.equal(postDeleteContentRes.status, 404);

  // 8. Post-delete Student Detail -> 404
  const postDeleteDetailRes = await requestWorker(`/api/student/books/${bookId}`, {
    booksBucket: mockBucket,
  });
  assert.equal(postDeleteDetailRes.status, 404);
});

test("Phase 3D: R2 delete failure is controlled and leaves metadata active", async () => {
  const bookId = `book-delete-failure-${Date.now().toString(36)}`;
  const mockBucket = new TestMockR2Bucket();
  const authHeaders = {
    "oai-authenticated-user-id": "admin-synth-001",
    "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
    "oai-authenticated-user-role": "admin",
  };

  const uploadRes = await requestWorker(`/api/admin/books/upload?id=${bookId}`, {
    method: "POST",
    headers: { "content-type": "application/pdf", ...authHeaders },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: mockBucket,
  });
  assert.equal(uploadRes.status, 201);
  const { book } = await uploadRes.json();

  mockBucket.failDelete = true;
  const deleteRes = await requestWorker(`/api/admin/books/${bookId}`, {
    method: "DELETE",
    headers: authHeaders,
    booksBucket: mockBucket,
  });
  assert.equal(deleteRes.status, 502);
  assert.equal((await deleteRes.json()).error, "r2_delete_failed");
  assert.ok(await mockBucket.head(book.objectKey), "Failed deletion must leave the R2 object present");

  const detailRes = await requestWorker(`/api/admin/books/${bookId}`, {
    headers: authHeaders,
    booksBucket: mockBucket,
  });
  assert.equal(detailRes.status, 200);
  assert.equal((await detailRes.json()).book.storageState, "active");
});

test("Phase 3D: Missing active R2 object returns controlled 404", async () => {
  const bookId = `book-missing-object-${Date.now().toString(36)}`;
  const mockBucket = new TestMockR2Bucket();
  const authHeaders = {
    "oai-authenticated-user-id": "admin-synth-001",
    "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
    "oai-authenticated-user-role": "admin",
  };

  const uploadRes = await requestWorker(`/api/admin/books/upload?id=${bookId}`, {
    method: "POST",
    headers: { "content-type": "application/pdf", ...authHeaders },
    body: SYNTHETIC_PDF_BYTES,
    booksBucket: mockBucket,
  });
  const { book } = await uploadRes.json();
  await mockBucket.delete(book.objectKey);

  const contentRes = await requestWorker(`/api/student/books/${bookId}/content`, {
    booksBucket: mockBucket,
  });
  assert.equal(contentRes.status, 404);
  assert.equal((await contentRes.json()).error, "object_not_found");

  const deleteRes = await requestWorker(`/api/admin/books/${bookId}`, {
    method: "DELETE",
    headers: authHeaders,
    booksBucket: mockBucket,
  });
  assert.equal(deleteRes.status, 404);
  assert.equal((await deleteRes.json()).error, "object_not_found");
});

test("Phase 3D: Production missing R2 binding returns controlled 503 r2_unavailable", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const res = await requestWorker("/api/admin/books/upload?id=book-prod-test", {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "oai-authenticated-user-id": "admin-synth-001",
        "oai-authenticated-user-email": "admin.tester@synthetic.ai-smartbook.test",
        "oai-authenticated-user-role": "admin",
      },
      body: SYNTHETIC_PDF_BYTES,
      // No booksBucket provided -> simulate missing binding
    });
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.error, "r2_unavailable");
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});
