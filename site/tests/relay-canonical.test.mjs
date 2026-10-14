import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalString, signRelay } from "../lib/relay-signature.ts";

const vector = {
  method: "post",
  pathname: "/API//V1/Resource/",
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

test("path canonicalization folds case, repeated slashes, and trailing slash without decoding escapes", async () => {
  const canonical = await buildCanonicalString(vector);
  const equivalent = await buildCanonicalString({
    ...vector,
    pathname: "//API///V1/RESOURCE",
  });
  assert.equal(equivalent, canonical);
  assert.equal((await buildCanonicalString({ ...vector, pathname: "/A/%2F/B/" })).split("\n")[2], "/a/%2f/b");
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
