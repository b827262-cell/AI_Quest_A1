import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = __dirname;
const DATA_DIR = path.join(FIXTURES_DIR, "data");
const ASSETS_DIR = path.join(FIXTURES_DIR, "assets");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });

const TIMESTAMP = "2026-09-14T00:00:00.000Z";
const PROVENANCE = "100% synthetic (site/fixtures/generate.ts)";

export const syntheticStudents = [
  {
    id: "student-synth-001",
    email: "student.alice@synthetic.ai-smartbook.test",
    displayName: "測試學生 Alice",
    role: "student",
    isSynthetic: true,
    schoolName: "合成測試中學",
    gradeLevel: "高一",
    createdAt: TIMESTAMP,
    provenance: PROVENANCE,
  },
  {
    id: "student-synth-002",
    email: "student.bob@synthetic.ai-smartbook.test",
    displayName: "測試學生 Bob",
    role: "student",
    isSynthetic: true,
    schoolName: "合成測試學院",
    gradeLevel: "大一",
    createdAt: TIMESTAMP,
    provenance: PROVENANCE,
  },
  {
    id: "admin-synth-001",
    email: "admin.tester@synthetic.ai-smartbook.test",
    displayName: "合成管理員",
    role: "admin",
    isSynthetic: true,
    schoolName: "系統管理部",
    gradeLevel: "職員",
    createdAt: TIMESTAMP,
    provenance: PROVENANCE,
  },
];

export const syntheticBooks = [
  {
    id: "book-synth-001",
    title: "計算機系統導論 (Synthetic)",
    description: "純合成教材，涵蓋計算機硬體結構、二進位運算與作業系統概論。",
    totalChapters: 8,
    totalPages: 160,
    isSynthetic: true,
    createdAt: TIMESTAMP,
    provenance: PROVENANCE,
  },
  {
    id: "book-synth-002",
    title: "高中數學演算法與邏輯思考 (Synthetic)",
    description: "純合成教材，解析基礎數論、遞迴與圖論思考。",
    totalChapters: 6,
    totalPages: 120,
    isSynthetic: true,
    createdAt: TIMESTAMP,
    provenance: PROVENANCE,
  },
];

export const syntheticProgress = [
  {
    id: "prog-synth-001",
    studentId: "student-synth-001",
    bookId: "book-synth-001",
    progressPercent: 68,
    lastReadChapter: "ch-03-binary-arithmetic",
    lastReadPage: 42,
    updatedAt: TIMESTAMP,
    isSynthetic: true,
    provenance: PROVENANCE,
  },
  {
    id: "prog-synth-002",
    studentId: "student-synth-002",
    bookId: "book-synth-002",
    progressPercent: 25,
    lastReadChapter: "ch-01-recursion-basics",
    lastReadPage: 15,
    updatedAt: TIMESTAMP,
    isSynthetic: true,
    provenance: PROVENANCE,
  },
];

export const syntheticRag = [
  {
    id: "rag-synth-001",
    bookId: "book-synth-001",
    chapterId: "ch-03-binary-arithmetic",
    chunkIndex: 0,
    heading: "二進位補數與加法運算",
    content: "二進位補數（Two's complement）是用於表示有號整數的常見方式。將數字取反加一即可獲得負數表示。",
    isSynthetic: true,
    provenance: PROVENANCE,
  },
  {
    id: "rag-synth-002",
    bookId: "book-synth-002",
    chapterId: "ch-01-recursion-basics",
    chunkIndex: 0,
    heading: "遞迴的基本條件與終止狀態",
    content: "遞迴函式必須包含基準條件（Base Case）與遞迴步驟（Recursive Step），確保執行時能順利終止。",
    isSynthetic: true,
    provenance: PROVENANCE,
  },
];

// Generate minimal valid PDF (PDF-1.4 binary structure)
function generateMinimalSyntheticPdf(): Buffer {
  const content = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 53 >>
stream
BT
/F1 12 Tf
100 700 Td
(Synthetic Test Book - Phase 1) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000201 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
305
%%EOF
`;
  return Buffer.from(content, "utf-8");
}

export function generateAllFixtures() {
  fs.writeFileSync(
    path.join(DATA_DIR, "students.synthetic.json"),
    JSON.stringify({ metadata: { count: syntheticStudents.length, provenance: PROVENANCE }, items: syntheticStudents }, null, 2)
  );
  fs.writeFileSync(
    path.join(DATA_DIR, "books.synthetic.json"),
    JSON.stringify({ metadata: { count: syntheticBooks.length, provenance: PROVENANCE }, items: syntheticBooks }, null, 2)
  );
  fs.writeFileSync(
    path.join(DATA_DIR, "progress.synthetic.json"),
    JSON.stringify({ metadata: { count: syntheticProgress.length, provenance: PROVENANCE }, items: syntheticProgress }, null, 2)
  );
  fs.writeFileSync(
    path.join(DATA_DIR, "rag.synthetic.json"),
    JSON.stringify({ metadata: { count: syntheticRag.length, provenance: PROVENANCE }, items: syntheticRag }, null, 2)
  );
  fs.writeFileSync(
    path.join(ASSETS_DIR, "synthetic-test-book.pdf"),
    generateMinimalSyntheticPdf()
  );

  console.log("✅ Synthetic fixtures generated successfully.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateAllFixtures();
}
