#!/usr/bin/env node
/**
 * Gates the exact directory handed to Sites. This checks on-disk bytes, not
 * HTTP compression sizes: a compressed response still fails a per-file upload
 * limit when its source artifact is oversized.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 25_000_000;
const uploadRoot = resolve(process.argv[2] || "dist");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  }));
  return nested.flat();
}

function readManifestEntries(text, manifestPath) {
  try {
    const json = JSON.parse(text);
    const needles = new Set();
    const collect = (value) => {
      if (typeof value === "string") needles.add(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(json);
    return [...needles].filter((value) => value.includes("ort-wasm") || value.endsWith(".wasm"))
      .map((value) => `${relative(uploadRoot, manifestPath)}:${value}`);
  } catch {
    return [];
  }
}

let files;
try {
  files = await walk(uploadRoot);
} catch (error) {
  console.error(`FILE_SIZE_GATE=FAIL reason=missing_upload_root root=${uploadRoot} error=${error.message}`);
  process.exit(1);
}

const records = await Promise.all(files.map(async (absolute) => ({
  absolute,
  path: relative(uploadRoot, absolute).split(sep).join("/"),
  bytes: (await stat(absolute)).size,
})));
records.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

const manifestPaths = records.filter(({ path }) => /(?:^|\/)(?:manifest|.*\.manifest)\.json$/i.test(path));
const manifestEntriesByFile = new Map(await Promise.all(manifestPaths.map(async ({ absolute, path }) => [
  path,
  readManifestEntries(await readFile(absolute, "utf8"), absolute),
])));
const oversize = records.filter(({ bytes }) => bytes > MAX_FILE_BYTES);
const manifestEntries = [...manifestEntriesByFile.values()].flat();
const packageRows = await Promise.all(records.map(async ({ absolute, path, bytes }) =>
  `${path}\0${bytes}\0${createHash("sha256").update(await readFile(absolute)).digest("hex")}\n`));
const packageSha = createHash("sha256").update(packageRows.sort().join("")).digest("hex");

console.log(`ACTUAL_UPLOAD_ROOT=${uploadRoot}`);
console.log(`PACKAGE_SHA=${packageSha}`);
console.log(`MAX_FILE_BYTES=${records[0]?.bytes ?? 0}`);
console.log(`MAX_FILE_LIMIT_BYTES=${MAX_FILE_BYTES}`);
console.log("TOP_20_FILES=");
for (const { path, bytes } of records.slice(0, 20)) console.log(`${path}:${bytes}`);
console.log("WASM_MANIFEST_ENTRIES=");
for (const entry of manifestEntries) console.log(entry);
if (oversize.length) {
  console.error("OVERSIZE_FILES=");
  for (const { path, bytes } of oversize) console.error(`${path}:${bytes}`);
  console.error("FILE_SIZE_GATE=FAIL");
  process.exit(1);
}
console.log("OVERSIZE_FILES=none");
console.log("FILE_SIZE_GATE=PASS");
