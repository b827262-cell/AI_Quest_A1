#!/usr/bin/env node
/**
 * Recompute PACKAGE_SHA from a per-file manifest, without the build directory.
 *
 * `site/scripts/verify-upload-package-size.mjs` defines PACKAGE_SHA as SHA-256
 * over the sorted concatenation of `path\0bytes\0sha256(file)\n`. A manifest
 * that records those three fields per file therefore carries enough information
 * to reproduce the digest, which is how a retained manifest is proven to belong
 * to the build instance it claims.
 *
 * Lives outside `site/` on purpose: the D-07 handoff asserts that `site/` is
 * byte-identical to its source SHA, so no verification tool may be added there.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("usage: derive-package-sha.mjs <manifest.txt>   (<sha256>  <bytes>  <path> per line)");
  process.exit(2);
}

const rows = readFileSync(manifestPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    const [sha, bytes, ...rest] = line.trim().split(/\s+/);
    return { sha, bytes: Number(bytes), path: rest.join(" ") };
  });

const bad = rows.filter(({ sha, bytes, path }) => !/^[0-9a-f]{64}$/.test(sha) || !Number.isFinite(bytes) || !path);
if (!rows.length || bad.length) {
  console.error(`MANIFEST_PARSE=FAIL rows=${rows.length} malformed=${bad.length}`);
  process.exit(1);
}

const payload = rows.map(({ path, bytes, sha }) => `${path}\0${bytes}\0${sha}\n`).sort().join("");
const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
const maxFileBytes = rows.reduce((max, row) => Math.max(max, row.bytes), 0);

console.log(`MANIFEST=${manifestPath}`);
console.log(`FILES=${rows.length}`);
console.log(`TOTAL_BYTES=${totalBytes}`);
console.log(`MAX_FILE_BYTES=${maxFileBytes}`);
console.log(`PACKAGE_SHA=${createHash("sha256").update(payload).digest("hex")}`);
