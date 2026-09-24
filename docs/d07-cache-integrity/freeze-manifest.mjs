#!/usr/bin/env node
/**
 * Canonical per-file manifest for a frozen build, plus the two digests it must
 * reproduce.
 *
 * Row order is part of the record, so it is defined here rather than left to a
 * collation: rows are compared as raw UTF-16 code units, which is exactly the
 * ordering `site/scripts/verify-upload-package-size.mjs` sorts by before hashing
 * `PACKAGE_SHA`. A locale-aware `localeCompare` sort was used once before and is
 * ICU/locale dependent, so two hosts could emit different byte orderings of the
 * same row set; that made "byte-identical manifest" an environment-specific
 * claim. Do not reintroduce it.
 *
 * Usage:
 *   freeze-manifest.mjs <upload-root>            # print digests, write nothing
 *   freeze-manifest.mjs <upload-root> <out.txt>  # also write the canonical manifest
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const [rootArg, outArg] = process.argv.slice(2);
if (!rootArg) {
  console.error("usage: freeze-manifest.mjs <upload-root> [manifest-out.txt]");
  process.exit(2);
}
const root = resolve(rootArg);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  }));
  return nested.flat();
}

const rows = [];
for (const absolute of await walk(root)) {
  const path = relative(root, absolute).split(sep).join("/");
  const buffer = await readFile(absolute);
  rows.push({
    path,
    bytes: buffer.byteLength,
    sha: createHash("sha256").update(buffer).digest("hex"),
  });
}
rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const gatePayload = rows.map(({ path, bytes, sha }) => `${path}\0${bytes}\0${sha}\n`).sort().join("");
const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
const maxFileBytes = rows.reduce((max, row) => Math.max(max, row.bytes), 0);

console.log(`UPLOAD_ROOT=${root}`);
console.log(`FILES=${rows.length}`);
console.log(`TOTAL_BYTES=${totalBytes}`);
console.log(`MAX_FILE_BYTES=${maxFileBytes}`);
console.log(`PACKAGE_SHA=${createHash("sha256").update(gatePayload).digest("hex")}`);
console.log(`ROW_SET_DIGEST=${createHash("sha256").update(JSON.stringify(rows.map(({ path, bytes, sha }) => [path, bytes, sha]))).digest("hex")}`);

if (outArg) {
  await writeFile(resolve(outArg), `${rows.map(({ sha, bytes, path }) => `${sha}  ${bytes}  ${path}`).join("\n")}\n`);
  console.log(`MANIFEST=${resolve(outArg)}`);
}
