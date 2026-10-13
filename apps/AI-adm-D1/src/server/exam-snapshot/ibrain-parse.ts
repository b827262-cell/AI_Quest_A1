import { createHash } from "node:crypto";
import { examCourseRecordV1Schema, type ExamCourseRecordV1, type ExamCourseYearV1 } from "@ai-smartbook/contracts";

/**
 * Parser for ec.ibrain.com.tw (Big5, classic ASP) public course pages.
 *
 * Two page shapes matter: a category listing page (layer.asp) whose product
 * anchors are named like "116高上 高考 財稅行政 全修課程", and a course detail
 * page (book.asp) whose field table is labelled 【師資】/【品號】/【適用】/
 * 【發行】/【出版】. Everything here is pure so the crawl can be replayed
 * against captured HTML in tests.
 */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  middot: "·",
  hellip: "…",
  bull: "•",
  reg: "®",
  copy: "©",
  trade: "™",
  times: "×",
  divide: "÷",
  deg: "°"
};

export function decodeIbrainEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match);
}

export function stripIbrainTags(html: string): string {
  const withoutMarkup = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeIbrainEntities(withoutMarkup).replace(/\s+/g, " ").trim();
}

/** The site declares charset=big5; UTF-8 is kept as a fallback for newer pages. */
export function decodeIbrainHtml(bytes: Uint8Array): string {
  try {
    return new TextDecoder("big5", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export function extractPageTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  const raw = decodeIbrainEntities(match[1].replace(/\s+/g, " ").trim());
  return raw.replace(/,\s*ibrain知識達購課館\s*$/i, "").trim();
}

export function extractMetaDescription(html: string): string {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  return match ? decodeIbrainEntities(match[1]).replace(/\s+/g, " ").trim() : "";
}

/**
 * Product field table. Labels are bracketed with 【…】 and the value is the
 * next table cell, so the pair is read from the flattened region text.
 */
export function extractProductFields(html: string): Record<string, string> {
  const region = stripIbrainTags(html);
  const fields: Record<string, string> = {};
  for (const match of region.matchAll(/【([^】]{1,8})】\s*([^\u3010]{1,240}?)(?=\s*【|$)/g)) {
    const label = match[1].trim();
    const value = match[2].trim();
    if (label && value && !(label in fields)) fields[label] = value;
  }
  return fields;
}

export function deriveExamYear(value: string): ExamCourseYearV1 | null {
  const match = value.match(/\b(1\d{2})\b/);
  if (!match) return null;
  const year = Number(match[1]);
  return year === 115 || year === 116 ? year : null;
}

/** Source-visible tiers are provenance only; the snapshot contract is 高普考. */
export function deriveCategory(_courseName: string, _fallback = "高普考"): "高普考" {
  return "高普考";
}

export type ListingCourseLink = Readonly<{
  bkid: string;
  courseName: string;
  url: string;
}>;

const LISTING_ANCHOR = /<a\s+href=["']?([^"'<>]*?book\.asp\?[^"'<>]*?bkid=(\d+)[^"'<>]*?)["']?\s*>([\s\S]{1,200}?)<\/[Aa]>/gi;

/** Course anchors of a category page, de-duplicated by bkid, first label wins. */
export function parseListingCourseLinks(html: string, origin: string): ListingCourseLink[] {
  const links = new Map<string, ListingCourseLink>();
  for (const match of html.matchAll(LISTING_ANCHOR)) {
    const href = match[1];
    const bkid = match[2];
    const label = stripIbrainTags(match[3]);
    if (!label || label.length < 4) continue;
    if (links.has(bkid)) continue;
    links.set(bkid, { bkid, courseName: label, url: `${origin}${href.startsWith("http") ? new URL(href).pathname : href}` });
  }
  return [...links.values()];
}

/** Product-region text: the field table plus the notices that follow it. */
export function extractCourseContent(html: string): string {
  const fields = extractProductFields(html);
  const parts: string[] = [];
  const description = extractMetaDescription(html);
  if (description) parts.push(description);
  for (const label of ["師資", "品號", "適用", "發行", "出版"]) {
    if (fields[label]) parts.push(`【${label}】${fields[label]}`);
  }
  const anchor = html.indexOf("【師資】") >= 0 ? html.indexOf("【師資】") : html.indexOf("【品號】");
  if (anchor >= 0) {
    const region = stripIbrainTags(html.slice(anchor, anchor + 12_000));
    if (region.length > 40) parts.push(region);
  }
  const notice = [...stripIbrainTags(html).matchAll(/(?:※|提醒：|優惠)[^【]{15,300}/g)].map((item) => item[0].trim());
  parts.push(...[...new Set(notice)].slice(0, 4));
  const deduped = [...new Set(parts.map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean))];
  return deduped.join(" ｜ ").slice(0, 20_000);
}

/** SHA-256 over the searchable payload only, so re-crawling an unchanged course is a no-op. */
export function computeContentHash(input: {
  exam_year: number;
  category: string;
  course_code: string;
  course_name: string;
  course_content: string;
  source_url: string;
}): string {
  const canonical = [
    input.exam_year,
    input.category,
    input.course_code,
    input.course_name,
    input.course_content.replace(/\s+/g, " ").trim(),
    input.source_url
  ].join("\u0001");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export type CourseDetailInput = Readonly<{
  html: string;
  url: string;
  listingCourseName?: string;
  fetchedAt: string;
}>;

/** Returns null when the page is not a 115/116 高普考 course (out of scope, not a failure). */
export function buildCourseRecord(input: CourseDetailInput): ExamCourseRecordV1 | null {
  const courseName = extractPageTitle(input.html) || input.listingCourseName || "";
  const examYear = deriveExamYear(courseName);
  if (!examYear) return null;
  const fields = extractProductFields(input.html);
  const courseCode = (fields["品號"] ?? "").trim();
  if (!courseCode) return null;
  const candidate = {
    exam_year: examYear,
    category: deriveCategory(courseName, deriveCategory(input.listingCourseName ?? "")),
    course_code: courseCode.slice(0, 128),
    course_name: courseName.slice(0, 512),
    course_content: extractCourseContent(input.html),
    source_url: input.url.slice(0, 2_048),
    fetched_at: input.fetchedAt,
    content_hash: computeContentHash({
      exam_year: examYear,
      category: deriveCategory(courseName, deriveCategory(input.listingCourseName ?? "")),
      course_code: courseCode.slice(0, 128),
      course_name: courseName.slice(0, 512),
      course_content: extractCourseContent(input.html),
      source_url: input.url.slice(0, 2_048)
    })
  };
  const parsed = examCourseRecordV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
