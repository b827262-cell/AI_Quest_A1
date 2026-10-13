import type { PublicCourseSearchResult } from "./knowledgeSearchContract";

export type GroundedSubject = Readonly<{
  subject: string;
  sourceField: "course_name" | "course_content";
  evidence: string;
}>;

export type KnowledgePriority = Readonly<{
  course: PublicCourseSearchResult;
  subjects: readonly GroundedSubject[];
  level: "subject" | "category";
  recommendation: string;
  evidenceStatus: "grounded" | "insufficient";
}>;

// Emitted candidates must occur literally in a source-visible field. This is
// extraction, not a subject taxonomy or external-AI inference.
const SUBJECT_PATTERN = /[\u4e00-\u9fff]{1,12}(?:法|學|概要|概論|原理|理論|實務)/g;
const GENERIC_COURSE_WORDS = /(課程|全修|題庫|總複習|行動版|高普考|普考|高考|一般民政)/g;

function candidates(text: string): string[] {
  return [...text.matchAll(SUBJECT_PATTERN)]
    .map((match) => match[0].replace(GENERIC_COURSE_WORDS, "").trim())
    .filter((candidate) => candidate.length >= 2 && text.includes(candidate));
}

/** Extract literal, source-backed subjects only; never fills gaps from a taxonomy. */
export function extractGroundedSubjects(course: PublicCourseSearchResult): GroundedSubject[] {
  const found: GroundedSubject[] = [];
  const seen = new Set<string>();
  for (const [sourceField, text] of [
    ["course_name", course.course_name],
    ["course_content", course.course_content]
  ] as const) {
    for (const subject of candidates(text)) {
      if (seen.has(subject)) continue;
      seen.add(subject);
      found.push({ subject, sourceField, evidence: text });
    }
  }
  return found;
}

/** Stable priority: name-backed subjects, then content-backed subjects, then category-only rows. */
export function buildKnowledgePriorities(courses: readonly PublicCourseSearchResult[]): KnowledgePriority[] {
  return courses.map((course): KnowledgePriority => {
    const subjects = extractGroundedSubjects(course);
    if (subjects.length === 0) return {
      course, subjects, level: "category", evidenceStatus: "insufficient",
      recommendation: "類科層級建議／資料不足：公開課程資料未提供可驗證的科目細節；不提供推測題目。"
    };
    return {
      course, subjects, level: "subject", evidenceStatus: "grounded",
      recommendation: `科目優先建議：先複習「${subjects.map((item) => item.subject).join("、")}」的公開課程內容。`
    };
  }).sort((left, right) => {
    const rank = (item: KnowledgePriority) => item.subjects.some((subject) => subject.sourceField === "course_name") ? 0 : item.level === "subject" ? 1 : 2;
    return rank(left) - rank(right);
  });
}
