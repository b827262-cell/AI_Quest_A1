import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PDF_PATH = path.join(__dirname, "assets", "synthetic-test-book.pdf");

export async function seedR2(r2Bucket?: R2Bucket) {
  if (!r2Bucket) {
    console.log("ℹ️ R2 bucket not bound; stubbing R2 seed step.");
    return;
  }

  if (fs.existsSync(PDF_PATH)) {
    const pdfBuffer = fs.readFileSync(PDF_PATH);
    await r2Bucket.put("books/book-synth-001/book.pdf", pdfBuffer, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { isSynthetic: "true" },
    });
    console.log("✅ Synthetic PDF seeded to R2 successfully.");
  }
}

if (process.argv[1] && process.argv[1].endsWith("seed-r2.ts")) {
  seedR2().catch((err) => console.error("Seed R2 notice:", err.message));
}
