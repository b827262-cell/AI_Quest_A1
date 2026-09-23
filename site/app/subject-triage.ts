/**
 * Subject Triage: classify a question into IT / ACCOUNTING / OTHER / UNKNOWN
 * BEFORE any model download. Uses lightweight local rules only — no AI calls.
 *
 * Per owner contract (Subject Triage First):
 *   IT = programming, CS, information security, software engineering
 *   ACCOUNTING = accounting, bookkeeping, debits/credits, financial statements
 *   OTHER = clearly non-IT non-accounting (history, science, language, etc.)
 *   UNKNOWN = ambiguous, mixed, or low-confidence — must not trigger model download
 */
export type SubjectCategory = "IT" | "ACCOUNTING" | "OTHER" | "UNKNOWN";

interface SubjectPattern {
  category: SubjectCategory;
  /** Simplified Chinese / Traditional Chinese / English keywords */
  keywords: string[];
  /** Minimum keyword hits required (for multi-keyword rules) */
  threshold?: number;
}

const SUBJECT_PATTERNS: SubjectPattern[] = [
  // IT — programming, CS, security, software engineering
  { category: "IT", keywords: ["程式設計", "程式", "編程", "寫程式", "程式開發"] },
  { category: "IT", keywords: ["程式語言", "python", "javascript", "java", "c++", "rust", "golang", "typescript"] },
  { category: "IT", keywords: ["資料結構", "演算法", "資料結構與演算法"] },
  { category: "IT", keywords: ["資訊安全", "資安", "滲透測試", "資安健檢", "sql injection", "xss"] },
  { category: "IT", keywords: ["軟體工程", "軟體開發", "software engineering", "devops", "ci/cd"] },
  { category: "IT", keywords: ["資料庫", "database", "sql", "mysql", "postgresql", "mongodb"] },
  { category: "IT", keywords: ["作業系統", "linux", "unix", "windows server"] },
  { category: "IT", keywords: ["雲端", "aws", "azure", "gcp", "cloud computing"] },
  { category: "IT", keywords: ["機器學習", "machine learning", "深度學習", "deep learning", "ai 模型", "類神經網路"] },
  { category: "IT", keywords: ["api", "restful", "graphql", "webhook"] },
  { category: "IT", keywords: ["前端", "後端", "fullstack", "full-stack", "web 開發", "網頁開發", "react", "vue"] },
  { category: "IT", keywords: ["版本控制", "git", "github", "gitlab"] },
  { category: "IT", keywords: ["資通安全", "網路安全", "cybersecurity", "firewall"] },

  // ACCOUNTING — core accounting concepts
  { category: "ACCOUNTING", keywords: ["會計", "會計學", "會計準則", "ifrs", "gaap"] },
  { category: "ACCOUNTING", keywords: ["借貸法則", "借貸", "复式簿記", "複式簿記"] },
  { category: "ACCOUNTING", keywords: ["分錄", "日記簿", "分類帳", "試算表"] },
  { category: "ACCOUNTING", keywords: ["資產負債表", "balance sheet", "損益表", "income statement"] },
  { category: "ACCOUNTING", keywords: ["現金流量表", "cash flow"] },
  { category: "ACCOUNTING", keywords: ["會計科目", "資產科目", "負債科目", "權益科目", "收入科目", "費用科目"] },
  { category: "ACCOUNTING", keywords: ["折舊", "攤銷", "depreciation", "amortization"] },
  { category: "ACCOUNTING", keywords: ["成本會計", "成本計算", "成本分攤"] },
  { category: "ACCOUNTING", keywords: ["審計", "審計報告", "internal control", "內部控制", "稽核"] },
  { category: "ACCOUNTING", keywords: ["稅務", "所得稅", "營業稅", "報稅", "節稅"] },
];

const OTHER_PATTERNS: SubjectPattern[] = [
  { category: "OTHER", keywords: ["歷史", "history", "朝代", "三國", "唐宋", "于右任", "人物傳記"] },
  { category: "OTHER", keywords: ["物理", "physics", "化學", "chemistry", "生物", "biology"] },
  { category: "OTHER", keywords: ["英文", "英語", "文法", "單字", "英文寫作", "英語教學"] },
  { category: "OTHER", keywords: ["數學", "微積分", "線性代數", "機率", "統計學"] },
  { category: "OTHER", keywords: ["地理", "geography", "公民", "社會科"] },
  { category: "OTHER", keywords: ["美術", "音樂", "體育", "藝術", "勞作"] },
  { category: "OTHER", keywords: ["國文", "作文", "閱讀測驗", "唐詩", "宋詞"] },
];

/**
 * Normalize text for keyword matching: lowercase, collapse whitespace.
 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Count how many keywords from the pattern appear in the text.
 */
function matchCount(text: string, pattern: SubjectPattern): number {
  let count = 0;
  for (const kw of pattern.keywords) {
    if (text.includes(kw.toLowerCase())) count += 1;
  }
  return count;
}

/**
 * Classify a question into a SubjectCategory.
 *
 * Strategy:
 *   - First match IT or ACCOUNTING keywords (specific domains).
 *   - If none match, check OTHER (clearly non-IT/non-accounting school subjects).
 *   * → UNKNOWN (ambiguous / mixed / no signal).
 *
 * Confidence heuristic: if exactly one category matches, use it.
 * If both IT and ACCOUNTING match (e.g. "accounting information system"),
 * return UNKNOWN so user can manually pick.
 */
export function classifySubject(question: string): SubjectCategory {
  const text = normalizeText(question);
  if (!text) return "UNKNOWN";

  const itMatch = SUBJECT_PATTERNS
    .filter((p) => p.category === "IT")
    .some((p) => matchCount(text, p) >= 1);

  const accountingMatch = SUBJECT_PATTERNS
    .filter((p) => p.category === "ACCOUNTING")
    .some((p) => matchCount(text, p) >= 1);

  // Conflict → UNKNOWN (user must decide)
  if (itMatch && accountingMatch) return "UNKNOWN";
  if (itMatch) return "IT";
  if (accountingMatch) return "ACCOUNTING";

  // No IT/ACCOUNTING match — check if clearly OTHER
  const otherMatch = OTHER_PATTERNS.some((p) => matchCount(text, p) >= 1);
  if (otherMatch) return "OTHER";

  return "UNKNOWN";
}

/**
 * Whether the category allows local Qwen model download.
 * Per owner contract: only IT and ACCOUNTING.
 */
export function canUseLocalModel(category: SubjectCategory): boolean {
  return category === "IT" || category === "ACCOUNTING";
}

/**
 * Human-readable label for the category (Traditional Chinese).
 */
export function subjectCategoryLabel(category: SubjectCategory): string {
  switch (category) {
    case "IT": return "資訊";
    case "ACCOUNTING": return "會計";
    case "OTHER": return "其他科目";
    case "UNKNOWN": return "未分類";
  }
}
