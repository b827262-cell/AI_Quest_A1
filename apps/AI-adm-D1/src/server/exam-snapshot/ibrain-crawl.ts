import {
  buildCourseRecord,
  decodeIbrainHtml,
  parseListingCourseLinks,
  type ListingCourseLink
} from "./ibrain-parse";
import { EXAM_COURSE_SOURCE_HOSTS_V1, type ExamCourseRecordV1 } from "@ai-smartbook/contracts";

/**
 * Bounded 115/116 高普考 snapshot crawl.
 *
 * The seed list below is explicit and complete for the scope agreed in A-01:
 * the 高普考 (bkid_1=1) category listing pages of ec.ibrain.com.tw plus the
 * detail pages they link. Nothing is discovered beyond those detail links, so
 * this cannot turn into a site crawler.
 */

export const IBRAIN_ORIGIN = "https://ec.ibrain.com.tw";

export type ExamSnapshotSeed = Readonly<{
  group: string;
  tier: "高考" | "普考" | "高普考共同科目";
  kindId3: string;
}>;

export const EXAM_SNAPSHOT_SEEDS: readonly ExamSnapshotSeed[] = [
  { group: "財稅行政", tier: "高考", kindId3: "3" },
  { group: "財稅行政", tier: "普考", kindId3: "8" },
  { group: "財稅法務", tier: "高考", kindId3: "987" },
  { group: "會計", tier: "高考", kindId3: "38" },
  { group: "會計", tier: "普考", kindId3: "48" },
  { group: "統計", tier: "高考", kindId3: "33" },
  { group: "統計", tier: "普考", kindId3: "36" },
  { group: "資訊處理", tier: "高考", kindId3: "288" },
  { group: "資訊處理", tier: "普考", kindId3: "289" },
  { group: "資通安全", tier: "高考", kindId3: "2189" },
  { group: "地政", tier: "高考", kindId3: "40" },
  { group: "地政", tier: "普考", kindId3: "43" },
  { group: "法制", tier: "高考", kindId3: "514" },
  { group: "審計", tier: "高考", kindId3: "978" },
  { group: "金融保險", tier: "高考", kindId3: "74" },
  { group: "金融保險", tier: "普考", kindId3: "75" },
  { group: "經建行政", tier: "高考", kindId3: "54" },
  { group: "經建行政", tier: "普考", kindId3: "55" },
  { group: "社會行政", tier: "高考", kindId3: "68" },
  { group: "社會行政", tier: "普考", kindId3: "69" },
  { group: "一般行政", tier: "高考", kindId3: "80" },
  { group: "一般行政", tier: "普考", kindId3: "81" },
  { group: "人事行政", tier: "高考", kindId3: "330" },
  { group: "人事行政", tier: "普考", kindId3: "332" },
  { group: "一般民政", tier: "高考", kindId3: "86" },
  { group: "一般民政", tier: "普考", kindId3: "87" },
  { group: "商業行政", tier: "高考", kindId3: "670" },
  { group: "法律廉政", tier: "高考", kindId3: "90" },
  { group: "法律廉政", tier: "普考", kindId3: "91" },
  { group: "財經廉政", tier: "高考", kindId3: "307" },
  { group: "財經廉政", tier: "普考", kindId3: "306" },
  { group: "戶政", tier: "高考", kindId3: "426" },
  { group: "戶政", tier: "普考", kindId3: "427" },
  { group: "司法行政", tier: "高考", kindId3: "1173" },
  { group: "衛生行政/技術", tier: "高考", kindId3: "525" },
  { group: "土木工程", tier: "高考", kindId3: "442" },
  { group: "高普考總複習", tier: "高考", kindId3: "375" },
  { group: "高普考總複習", tier: "普考", kindId3: "981" },
  { group: "共同科目", tier: "高普考共同科目", kindId3: "12" }
] as const;

export function seedListingUrl(seed: ExamSnapshotSeed): string {
  return `${IBRAIN_ORIGIN}/Publish/www/layer.asp?bkid_1=1&KindID3=${encodeURIComponent(seed.kindId3)}`;
}

export type FetchedPage = Readonly<{ status: number; body: Uint8Array }>;
export type PageFetcher = (url: string, signal?: AbortSignal) => Promise<FetchedPage>;

export const defaultPageFetcher: PageFetcher = async (url, signal) => {
  const parsed = new URL(url);
  if (!EXAM_COURSE_SOURCE_HOSTS_V1.includes(parsed.hostname as (typeof EXAM_COURSE_SOURCE_HOSTS_V1)[number])) {
    throw new Error(`off-whitelist host: ${parsed.hostname}`);
  }
  const response = await fetch(url, {
    signal,
    redirect: "follow",
    headers: { "User-Agent": "A01-ExamSnapshotBot/1.0 (learning catalog snapshot; public pages only)" }
  });
  const finalHost = new URL(response.url || url).hostname;
  if (!EXAM_COURSE_SOURCE_HOSTS_V1.includes(finalHost as (typeof EXAM_COURSE_SOURCE_HOSTS_V1)[number])) {
    throw new Error(`off-whitelist redirect host: ${finalHost}`);
  }
  return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
};

export type ExamSnapshotFailure = Readonly<{
  url: string;
  stage: "listing" | "detail";
  status?: number;
  reason: string;
}>;

export type ExamSnapshotCrawlResult = Readonly<{
  records: ExamCourseRecordV1[];
  failures: ExamSnapshotFailure[];
  listingPagesFetched: number;
  candidateLinks: number;
  detailPagesFetched: number;
  skippedOutOfScope: number;
}>;

export type ExamSnapshotCrawlOptions = Readonly<{
  seeds?: readonly ExamSnapshotSeed[];
  fetcher?: PageFetcher;
  maxDetailPages?: number;
  delayMs?: number;
  fetchedAt?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function detailUrl(link: ListingCourseLink): string {
  return `${IBRAIN_ORIGIN}${link.url}`;
}

export async function runExamSnapshotCrawl(options: ExamSnapshotCrawlOptions = {}): Promise<ExamSnapshotCrawlResult> {
  const seeds = options.seeds ?? EXAM_SNAPSHOT_SEEDS;
  const fetcher = options.fetcher ?? defaultPageFetcher;
  const maxDetailPages = options.maxDetailPages ?? 80;
  const delayMs = options.delayMs ?? 80;
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();

  const failures: ExamSnapshotFailure[] = [];
  const candidates = new Map<string, { link: ListingCourseLink; group: string }>();

  let listingPagesFetched = 0;
  for (const seed of seeds) {
    const url = seedListingUrl(seed);
    try {
      const page = await fetcher(url, options.signal);
      if (page.status !== 200) {
        failures.push({ url, stage: "listing", status: page.status, reason: "non-200 listing response" });
        continue;
      }
      const html = decodeIbrainHtml(page.body);
      const links = parseListingCourseLinks(html, IBRAIN_ORIGIN).filter(
        (link) => /11[56]/.test(link.courseName) && /高考|普考/.test(link.courseName)
      );
      listingPagesFetched += 1;
      for (const link of links) {
        if (!candidates.has(link.bkid)) candidates.set(link.bkid, { link, group: seed.group });
      }
    } catch (error) {
      failures.push({ url, stage: "listing", reason: error instanceof Error ? error.message : "listing fetch failed" });
    }
    options.onProgress?.(`listing ${seed.group}/${seed.tier} → ${candidates.size} candidates`);
    if (delayMs > 0) await sleep(delayMs);
  }

  const records: ExamCourseRecordV1[] = [];
  const seenCodes = new Set<string>();
  let detailPagesFetched = 0;
  let skippedOutOfScope = 0;

  for (const { link } of candidates.values()) {
    if (detailPagesFetched >= maxDetailPages) break;
    const url = detailUrl(link);
    detailPagesFetched += 1;
    try {
      const page = await fetcher(url, options.signal);
      if (page.status !== 200) {
        failures.push({ url, stage: "detail", status: page.status, reason: "non-200 detail response" });
        continue;
      }
      const record = buildCourseRecord({ html: decodeIbrainHtml(page.body), url, listingCourseName: link.courseName, fetchedAt });
      if (!record) {
        skippedOutOfScope += 1;
        continue;
      }
      // Same course_code can be advertised on two category pages; first group wins.
      const key = `${record.exam_year}\u0000${record.course_code}`;
      if (seenCodes.has(key)) continue;
      seenCodes.add(key);
      records.push(record);
    } catch (error) {
      failures.push({ url, stage: "detail", reason: error instanceof Error ? error.message : "detail fetch failed" });
    }
    options.onProgress?.(`detail ${detailPagesFetched}/${candidates.size} → ${records.length} records`);
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    records,
    failures,
    listingPagesFetched,
    candidateLinks: candidates.size,
    detailPagesFetched,
    skippedOutOfScope
  };
}
