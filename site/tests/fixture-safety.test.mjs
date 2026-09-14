import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "fixtures", "data");

test("Safety Gate 1/10: No production PII in synthetic fixtures", () => {
  const studentsFile = path.join(DATA_DIR, "students.synthetic.json");
  const data = JSON.parse(fs.readFileSync(studentsFile, "utf-8"));
  for (const s of data.items) {
    assert.match(s.email, /@synthetic\.ai-smartbook\.test$/);
    assert.match(s.displayName, /測試|合成/);
    assert.equal(s.isSynthetic, true);
  }
});

test("Safety Gate 2/10 & 3/10: No production credentials or sessions", () => {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DATA_DIR, f), "utf-8");
    assert.doesNotMatch(raw, /\$2[aby]\$\d+\$/); // bcrypt
    assert.doesNotMatch(raw, /"password_hash"/);
    assert.doesNotMatch(raw, /"session_token"/);
  }
});

test("Safety Gate 4/10 & 5/10: No production chat logs or external IPs", () => {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DATA_DIR, f), "utf-8");
    const ips = raw.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
    for (const ip of ips) {
      assert.ok(ip === "127.0.0.1" || ip === "0.0.0.0");
    }
  }
});

test("Safety Gate 6/10 & 7/10: No secrets in site source or bundle", () => {
  const siteDir = path.join(__dirname, "..");
  const distDir = path.join(siteDir, "dist");
  if (fs.existsSync(distDir)) {
    const checkFile = (f) => {
      const content = fs.readFileSync(f, "utf-8");
      assert.doesNotMatch(content, /sk-[a-zA-Z0-9]{20,}/);
      assert.doesNotMatch(content, /AIza[0-9A-Za-z-_]{35}/);
    };
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile() && (full.endsWith(".js") || full.endsWith(".html"))) checkFile(full);
      }
    };
    walk(distDir);
  }
});

test("Safety Gate 9/10: Fixture provenance = 100% synthetic", () => {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf-8"));
    assert.ok(data.metadata.provenance.includes("synthetic"));
    for (const item of data.items) {
      assert.ok(item.provenance.includes("synthetic"));
    }
  }
});

test("Safety Gate 10/10: Production DB access is physically impossible in site", () => {
  const siteDir = path.join(__dirname, "..");
  const filesToCheck = [
    path.join(siteDir, "fixtures", "generate.ts"),
    path.join(siteDir, "db", "index.ts"),
    path.join(siteDir, "db", "schema.ts"),
  ];
  for (const f of filesToCheck) {
    const content = fs.readFileSync(f, "utf-8");
    assert.doesNotMatch(content, /better-sqlite3/);
    assert.doesNotMatch(content, /\/opt\/ai-smartbook/);
    assert.doesNotMatch(content, /ai-smartbook-r1\.db/);
  }
});
