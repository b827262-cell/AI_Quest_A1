import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbHandle } from "@ai-smartbook/db";
import { createAdminApp } from "./app";
import { createAdminTestDependencies } from "./dependencies";

let cleanupFailEnabled = false;

vi.mock("node:fs", () => {
  const fs = require("node:fs");
  const originalUnlinkSync = fs.unlinkSync;
  return {
    ...fs,
    unlinkSync: vi.fn((path) => {
      if (cleanupFailEnabled) {
        throw new Error("cleanup denied");
      }
      return originalUnlinkSync(path);
    }),
  };
});

const directories: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "a01-upload-security-"));
  directories.push(directory);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    UPLOAD_DIR: join(directory, "uploads"),
    ADMIN_API_TOKEN: "upload-test-token",
    AI_CREDENTIAL_ENCRYPTION_KEY: "upload-test-encryption-key-0123456789",
    AI_PROVIDER: "mock",
    AI_GATEWAY_ENABLED: "false",
    ADMIN_ALLOWED_ORIGINS: "http://127.0.0.1:5174",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "test-password"
  };
  process.env = { ...env, SQLITE_PATH: join(directory, "admin.db") };
  delete process.env.ADMIN_PASSWORD_HASH;
  const dependencies = createAdminTestDependencies(process.env, createDbHandle(join(directory, "admin.db")));
  const app = createAdminApp(dependencies);
  const book = dependencies.repos.books.create({ title: "Upload security fixture" });
  return { app, dependencies, book, directory, uploadDir: env.UPLOAD_DIR, token: env.ADMIN_API_TOKEN };
}

function filesIn(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const pdf = Buffer.from("%PDF-1.7\n%%EOF\n");

describe("admin upload security boundaries", () => {
  it("serves only raster appearance uploads and blocks an existing SVG URL", async () => {
    const { app, uploadDir, token } = fixture();
    const appearanceDir = join(uploadDir, "appearance");
    mkdirSync(appearanceDir, { recursive: true });
    writeFileSync(join(appearanceDir, "legacy.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await request(app).get("/api/uploads/appearance/legacy.svg")).status).toBe(404);

    const images = [
      { bytes: png, filename: "logo.png", type: "image/png" },
      { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), filename: "logo.jpg", type: "image/jpeg" },
      { bytes: Buffer.from("RIFFxxxxWEBP", "ascii"), filename: "logo.webp", type: "image/webp" }
    ];
    for (const image of images) {
      const good = await request(app).post("/api/admin/appearance-settings/upload")
        .set("x-admin-token", token).attach("file", image.bytes, { filename: image.filename, contentType: image.type });
      expect(good.status, JSON.stringify(good.body)).toBe(201);
      const served = await request(app).get(good.body.url);
      expect(served.status).toBe(200);
      expect(served.headers["x-content-type-options"]).toBe("nosniff");
      expect(served.headers["content-security-policy"]).toBe("sandbox");
    }

    const svg = await request(app).post("/api/admin/appearance-settings/upload")
      .set("x-admin-token", token).attach("file", Buffer.from("<svg/>"), { filename: "x.svg", contentType: "image/svg+xml" });
    const spoof = await request(app).post("/api/admin/appearance-settings/upload")
      .set("x-admin-token", token).attach("file", Buffer.from("<svg/>"), { filename: "x.png", contentType: "image/png" });
    expect([svg.status, spoof.status]).toEqual([415, 415]);
    expect(filesIn(appearanceDir)).toHaveLength(4); // blocked legacy SVG and three accepted rasters
  });

  it("maps oversize and malformed uploads, with no new appearance file", async () => {
    const { app, uploadDir, token } = fixture();
    const missing = await request(app).post("/api/admin/appearance-settings/upload").set("x-admin-token", token);
    const huge = await request(app).post("/api/admin/appearance-settings/upload")
      .set("x-admin-token", token).attach("file", Buffer.alloc(2 * 1024 * 1024 + 1), { filename: "big.png", contentType: "image/png" });
    const malformed = await request(app).post("/api/admin/appearance-settings/upload")
      .set("x-admin-token", token).set("content-type", "multipart/form-data; boundary=broken").send("not multipart");
    expect([missing.status, huge.status, malformed.status]).toEqual([400, 413, 400]);
    expect(filesIn(join(uploadDir, "appearance"))).toHaveLength(0);
    const exact = Buffer.alloc(2 * 1024 * 1024);
    png.copy(exact);
    const accepted = await request(app).post("/api/admin/appearance-settings/upload").set("x-admin-token", token)
      .attach("file", exact, { filename: "exact.png", contentType: "image/png" });
    expect(accepted.status).toBe(201);
    expect(filesIn(join(uploadDir, "appearance"))).toHaveLength(1);
  });

  it("caps book files at 25 MiB and removes rejected files", async () => {
    const { app, book, uploadDir, token } = fixture();
    const endpoint = `/api/admin/books/${book.id}/files`;
    const invalid = await request(app).post(endpoint).set("x-admin-token", token)
      .attach("file", Buffer.from("not a PDF"), { filename: "fake.pdf", contentType: "application/pdf" });
    const wrongRole = await request(app).post(endpoint).set("x-admin-token", token)
      .field("role", "reader_toc")
      .attach("file", pdf, { filename: "valid.pdf", contentType: "application/pdf" });
    const wrongExt = await request(app).post(endpoint).set("x-admin-token", token)
      .attach("file", pdf, { filename: "fake.svg", contentType: "application/pdf" });
    const wrongMime = await request(app).post(endpoint).set("x-admin-token", token)
      .attach("file", pdf, { filename: "fake.pdf", contentType: "image/png" });
    const huge = Buffer.alloc(25 * 1024 * 1024 + 1);
    pdf.copy(huge);
    const oversized = await request(app).post(endpoint).set("x-admin-token", token)
      .attach("file", huge, { filename: "huge.pdf", contentType: "application/pdf" });
    expect([invalid.status, wrongRole.status, wrongExt.status, wrongMime.status, oversized.status]).toEqual([415, 400, 415, 415, 413]);
    expect(filesIn(join(uploadDir, book.id))).toHaveLength(0);
    expect(filesIn(join(uploadDir, ".pending"))).toHaveLength(0);

    const exact = Buffer.alloc(25 * 1024 * 1024);
    pdf.copy(exact);
    const accepted = await request(app).post(endpoint).set("x-admin-token", token)
      .attach("file", exact, { filename: "valid.pdf", contentType: "application/pdf" });
    expect(accepted.status).toBe(201);
    expect(accepted.body.file.fileSize).toBe(exact.length);
    expect(filesIn(join(uploadDir, book.id))).toHaveLength(1);
  });

  it("blocks new and legacy reference-image SVG at the authenticated raw route", async () => {
    const { app, book, dependencies, uploadDir, token } = fixture();
    const endpoint = `/api/admin/books/${book.id}/files`;
    const source = await request(app).post(endpoint).set("x-admin-token", token)
      .attach("file", pdf, { filename: "source.pdf", contentType: "application/pdf" });
    expect(source.status).toBe(201);
    const relatedFileId = source.body.file.id;
    const svg = await request(app).post(endpoint).set("x-admin-token", token)
      .field("role", "reference_image").field("relatedFileId", relatedFileId)
      .attach("file", Buffer.from("<svg><script>alert(1)</script></svg>"), { filename: "attack.svg", contentType: "image/svg+xml" });
    const spoof = await request(app).post(endpoint).set("x-admin-token", token)
      .field("role", "reference_image").field("relatedFileId", relatedFileId)
      .attach("file", Buffer.from("<svg/>"), { filename: "attack.png", contentType: "image/png" });
    expect([svg.status, spoof.status]).toEqual([415, 415]);
    const good = await request(app).post(endpoint).set("x-admin-token", token)
      .field("role", "reference_image").field("relatedFileId", relatedFileId)
      .attach("file", png, { filename: "image.png", contentType: "image/png" });
    expect(good.status).toBe(201);
    const raw = await request(app).get(`/api/admin/books/${book.id}/files/${good.body.file.id}/raw`).set("x-admin-token", token);
    expect(raw.status).toBe(200);
    expect(raw.headers["content-security-policy"]).toBe("sandbox");
    const legacyPath = join(uploadDir, book.id, "legacy.svg");
    writeFileSync(legacyPath, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const legacy = dependencies.repos.files.create({
      bookId: book.id, fileName: "legacy.svg", filePath: legacyPath, fileType: "image/svg+xml",
      fileSize: 78, role: "reference_image", relatedFileId, parseStatus: "pending"
    });
    const blocked = await request(app).get(`/api/admin/books/${book.id}/files/${legacy.id}/raw`).set("x-admin-token", token);
    expect(blocked.status).toBe(404);
    expect(filesIn(join(uploadDir, book.id))).toHaveLength(3); // PDF, PNG, legacy SVG; rejected files are absent
  });

  it("rejects an unknown book before persisting and cleans up a failed repository insert", async () => {
    const { app, book, dependencies, uploadDir, token } = fixture();
    const unknown = await request(app).post("/api/admin/books/missing/files").set("x-admin-token", token)
      .attach("file", pdf, { filename: "valid.pdf", contentType: "application/pdf" });
    expect(unknown.status).toBe(404);
    vi.spyOn(dependencies.repos.files, "create").mockImplementation(() => { throw new Error("sensitive database fault"); });
    const failed = await request(app).post(`/api/admin/books/${book.id}/files`).set("x-admin-token", token)
      .attach("file", pdf, { filename: "valid.pdf", contentType: "application/pdf" });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain("sensitive database fault");
    expect(filesIn(join(uploadDir, book.id))).toHaveLength(0);
    expect(filesIn(join(uploadDir, ".pending"))).toHaveLength(0);
  });

  it("maps JSON-index oversize to 413 and removes its artifact on repository failure", async () => {
    const { app, book, dependencies, uploadDir, token } = fixture();
    const endpoint = `/api/admin/books/${book.id}/json-indexes/upload`;
    const oversize = await request(app).post(endpoint).set("x-admin-token", token)
      .attach("file", Buffer.alloc(25 * 1024 * 1024 + 1), { filename: "huge.json", contentType: "application/json" });
    expect(oversize.status).toBe(413);
    const index = {
      schemaVersion: "smartbook-pdf-index-v1", bookId: book.id, fileId: "source-id", fileName: "source.pdf",
      level: "page", levelLabel: "簡單", generatedAt: new Date().toISOString(), pageCount: 0,
      itemCount: 0, source: { pageNumberMode: "pdf_physical_page" }, items: []
    };
    vi.spyOn(dependencies.repos.files, "create").mockImplementation(() => { throw new Error("sensitive index insert fault"); });
    const failed = await request(app).post(endpoint).set("x-admin-token", token)
      .attach("file", Buffer.from(JSON.stringify(index)), { filename: "index.json", contentType: "application/json" });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain("sensitive index insert fault");
    expect(filesIn(join(uploadDir, book.id))).toHaveLength(0);
  });

  it("logs a cleanup failure without disclosing the path or making the orphan reachable", async () => {
    const { app, book, dependencies, uploadDir, token } = fixture();
    const bookDir = join(uploadDir, book.id);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(dependencies.repos.files, "create").mockImplementation(() => {
      throw new Error("private database fault");
    });
    cleanupFailEnabled = true;
    try {
      const failed = await request(app).post(`/api/admin/books/${book.id}/files`).set("x-admin-token", token)
        .attach("file", pdf, { filename: "valid.pdf", contentType: "application/pdf" });
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain("private database fault");
      expect(warning).toHaveBeenCalledWith("[upload] failed to remove uncommitted file");
      expect(filesIn(bookDir)).toHaveLength(1);
      const raw = await request(app).get(`/api/admin/books/${book.id}/files/no-row/raw`).set("x-admin-token", token);
      expect(raw.status).toBe(404);
    } finally {
      cleanupFailEnabled = false;
      vi.restoreAllMocks();
    }
  });
});
