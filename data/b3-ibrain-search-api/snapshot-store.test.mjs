import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createSnapshotStore, loadSnapshotStore } from "./snapshot-store.mjs";
import { createSearchServer } from "./search-server.mjs";

const rows = [
  { exam_year: 115, course_code: "ABC1", course_name: "統計學 題庫班", course_content: "考古題與經典題型", source_url: "https://ec.ibrain.com.tw/a" },
  { exam_year: 116, course_code: "abc2", course_name: "行政學 總複習", course_content: "重點整理 題型演練", source_url: "https://ec.ibrain.com.tw/b" },
  { exam_year: 115, course_code: "XYZ9", course_name: "經濟學 題庫班", course_content: "計算題", source_url: "https://ec.ibrain.com.tw/c" },
];

test("exact matches course_code case-insensitively and filters by exam_year", async () => {
  const store = createSnapshotStore({ rows });
  assert.deepEqual((await store.exact({ courseCode: "abc1", limit: 10 })).map((r) => r.course_code), ["ABC1"]);
  assert.deepEqual(await store.exact({ courseCode: "ABC2", examYear: 115, limit: 10 }), []);
});

test("keyword matches name or content, multi-term AND, ordered by year desc then name", async () => {
  const store = createSnapshotStore({ rows });
  // Same year: course_name code-point order ("統" U+7D71 < "經" U+7D93), as in PostgreSQL C collation.
  assert.deepEqual((await store.keyword({ keyword: "題庫班", limit: 10 })).map((r) => r.course_code), ["ABC1", "XYZ9"]);
  assert.deepEqual((await store.keyword({ keyword: "題型", limit: 10 })).map((r) => r.exam_year), [116, 115]);
  assert.deepEqual((await store.keyword({ keyword: "行政學 演練", limit: 10 })).map((r) => r.course_code), ["abc2"]);
  assert.equal((await store.keyword({ keyword: "題", limit: 1 })).length, 1);
});

test("teacher and scope are NULL in the snapshot, as in the B2 import", async () => {
  const store = createSnapshotStore({ rows });
  assert.deepEqual(await store.teacher({ keyword: "趙", limit: 10 }), []);
  assert.deepEqual(await store.scope({ keyword: "高普考", limit: 10 }), []);
  const [row] = await store.exact({ courseCode: "ABC1", limit: 1 });
  assert.deepEqual(Object.keys(row), ["exam_year", "course_code", "course_name", "course_content", "teacher", "applicable_scope", "source_url"]);
  assert.equal(row.teacher, null);
});

test("loads the real validated 16-row B1 snapshot and serves it over HTTP", async () => {
  const store = await loadSnapshotStore();
  assert.equal(store.kind, "snapshot");
  const all = await store.keyword({ keyword: "高普考", limit: 100 });
  assert.ok(all.length > 0 && all.length <= 16);

  const server = createSearchServer({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const code = all[0].course_code;
    const res = await fetch(`http://127.0.0.1:${port}/api/public/exam-courses/search?q=${encodeURIComponent(code)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(JSON.stringify(body).includes(code));
    assert.equal(body.mode, "snapshot");
  } finally {
    server.close();
  }
});
