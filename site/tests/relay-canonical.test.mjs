import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalString, signRelay } from "../lib/relay-signature.ts";

const vector = {
  method: "post",
  pathname: "/api//v1/resource/",
  search: "?b=2&a=1",
  body: new TextEncoder().encode('{"x":1}'),
  site: "student",
  userId: "user-123",
  email: " Alice@Example.COM ",
  role: "student",
  ts: "1700000000",
  nonce: "0123456789abcdef",
};

const expectedCanonical = [
  "a01-relay-v1",
  "POST",
  "/api/v1/resource",
  "f3282a131a04dd0ccd63700e768fce9c678bcec4147d4af35d36be389eceac7a",
  "5041bf1f713df204784353e82f6a4a535931cb64f1f4b4a5aeaffcb720918b22",
  "student",
  "user-123",
  "alice@example.com",
  "student",
  "1700000000",
  "0123456789abcdef",
].join("\n");
const expectedSignatureHex = "02effcae24c76ba816bb9ccf267c227d06baea2a75e61e337d9dd771b1525b40";
const expectedSignatureBase64Url = "Au_8riTHa6gWu5zPJnwifQa66ip15h4zfZ3XcbFSW0A";

test("fixed canonical and HMAC-SHA256 vector", async () => {
  assert.equal(await buildCanonicalString(vector), expectedCanonical);
  const signature = await signRelay(vector, "test-secret");
  assert.equal(signature, expectedSignatureBase64Url);
  assert.equal(Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex"), expectedSignatureHex);
});

test("path canonicalization preserves case, folds repeated slashes, and strips a trailing slash without decoding escapes", async () => {
  const canonical = await buildCanonicalString(vector);
  const equivalent = await buildCanonicalString({
    ...vector,
    pathname: "//api///v1/resource",
  });
  assert.equal(equivalent, canonical);
  assert.equal((await buildCanonicalString({ ...vector, pathname: "/A/%2F/B/" })).split("\n")[2], "/A/%2F/B");
});

test("case-different paths now yield different canonical strings and signatures", async () => {
  const upper = await buildCanonicalString({ ...vector, pathname: "/A/" });
  const lower = await buildCanonicalString({ ...vector, pathname: "/a" });
  assert.equal(upper.split("\n")[2], "/A");
  assert.equal(lower.split("\n")[2], "/a");
  assert.notEqual(upper, lower);
  assert.notEqual(
    await signRelay({ ...vector, pathname: "/BookA" }, "test-secret"),
    await signRelay({ ...vector, pathname: "/booka" }, "test-secret"),
  );
});

test("query digest distinguishes an empty search from a non-empty raw search", async () => {
  const empty = await buildCanonicalString({ ...vector, search: "" });
  const present = await buildCanonicalString({ ...vector, search: "?x=1" });
  assert.equal(empty.split("\n")[3], "-");
  assert.equal(present.split("\n")[3], "12c091ef4fc80899e4c9e4dd77b726570ea50c6a482e6b8ce8fdd877f2d56922");
  assert.notEqual(empty, present);
});

test("GET and HEAD omit body digests while POST hashes body bytes", async () => {
  for (const method of ["GET", "HEAD"]) {
    const canonical = await buildCanonicalString({ ...vector, method, body: "ignored body" });
    assert.equal(canonical.split("\n")[4], "-");
  }
  const post = await buildCanonicalString({ ...vector, method: "POST", body: "abc" });
  assert.equal(post.split("\n")[4], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("control characters and line separators are rejected in every field", async () => {
  const forbidden = [
    "x\r", "x\n", "x\u2028", "x\u2029", "x\u0085", "x\u000b", "x\u000c",
    "x\u0000", "x\u001f", "x\u007f", "x\u009f",
  ];
  const fields = ["method", "pathname", "search", "site", "userId", "email", "role", "ts", "nonce"];
  for (const field of fields) {
    for (const value of forbidden) {
      assert.deepEqual(
        await signRelay({ ...vector, [field]: value }, "test-secret"),
        { ok: false },
        `${field}=${JSON.stringify(value)} must be rejected`,
      );
    }
  }
});

test("control ranges reject their boundaries and allow adjacent characters", async () => {
  const rejected = [0x0000, 0x001f, 0x007f, 0x009f, 0x2028, 0x2029];
  for (const code of rejected) {
    const userId = `user-${String.fromCharCode(code)}`;
    assert.deepEqual(await signRelay({ ...vector, userId }, "test-secret"), { ok: false }, `U+${code.toString(16)}`);
  }

  const allowed = [0x0020, 0x007e, 0x00a0, 0x2027, 0x202a];
  for (const code of allowed) {
    const userId = `user-${String.fromCharCode(code)}`;
    assert.equal(typeof await buildCanonicalString({ ...vector, userId }), "string", `U+${code.toString(16)}`);
  }
});

test("unpaired surrogates are rejected so distinct strings cannot share a signature", async () => {
  const loneSurrogates = ["a\ud800", "a\ud801", "a\ud83d", "a\udc00", "a\udfff", "\ud800"];
  for (const value of loneSurrogates) {
    assert.deepEqual(
      await signRelay({ ...vector, userId: value }, "test-secret"),
      { ok: false },
      `${JSON.stringify(value)} must be rejected`,
    );
  }
  // Well-formed surrogate pairs (e.g. an emoji) stay valid.
  const paired = await buildCanonicalString({ ...vector, userId: "user-\u{1f600}" });
  assert.equal(typeof paired, "string");
});
