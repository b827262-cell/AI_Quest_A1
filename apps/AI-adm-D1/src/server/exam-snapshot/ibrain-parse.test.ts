import { describe, expect, it } from "vitest";
import { buildCourseRecord, deriveCategory, deriveExamYear } from "./ibrain-parse";
import { runExamSnapshotCrawl } from "./ibrain-crawl";

describe("ibrain course category parsing", () => {
  it.each(["高普考行政法", "高考財稅行政", "普考會計"])("normalizes %s to the 高普考 contract", (courseName) => {
    expect(deriveCategory(courseName)).toBe("高普考");
  });

  it("emits 高普考 for a published 普考 course", () => {
    const record = buildCourseRecord({
      html: "<title>116 普考 會計學, ibrain知識達購課館</title><table><tr><td>【品號】</td><td>IPPP001</td></tr></table>",
      url: "https://ec.ibrain.com.tw/book.asp?bkid=1",
      fetchedAt: "2026-10-04T00:00:00.000Z"
    });

    expect(record).toMatchObject({ category: "高普考", exam_year: 116, course_code: "IPPP001" });
  });

  it("treats a 115 page as out of scope instead of a failure", () => {
    expect(deriveExamYear("115年高普考【財稅行政】經濟學")).toBeNull();
    expect(deriveExamYear("116年高普考【財稅行政】經濟學")).toBe(116);
    expect(buildCourseRecord({
      html: "<title>115 普考 會計學, ibrain知識達購課館</title><table><tr><td>【品號】</td><td>IPPP115</td></tr></table>",
      url: "https://ec.ibrain.com.tw/book.asp?bkid=2",
      fetchedAt: "2026-10-04T00:00:00.000Z"
    })).toBeNull();
  });
});

describe("real iBrain detail fields", () => {
  it("maps the captured product fields", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("./fixtures/ibrain-book-18229.html", import.meta.url), "utf8");
    const record = buildCourseRecord({ html, url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18229", fetchedAt: "2026-10-04T00:00:00.000Z" });
    expect(record).toMatchObject({ course_code: "IPKK2327021", teacher: expect.stringContaining("高上高普特考師資群"), applicable_scope: "高普考" });
  });

  it("limits oversized optional fields without rejecting the course", () => {
    const html = `<title>116 高考 課程</title>【師資】${"師".repeat(150)}【品號】ABC【適用】${"適".repeat(300)}【發行】出版社`;
    const record = buildCourseRecord({ html, url: "https://ec.ibrain.com.tw/book.asp?bkid=1", fetchedAt: "2026-10-04T00:00:00.000Z" });
    expect(record?.teacher).toHaveLength(128);
    expect(record?.applicable_scope?.length).toBeLessThanOrEqual(256);
    expect(record?.course_code).toBe("ABC");
  });
});


describe("detail page default limit", () => {
  it("fetches at most 120 candidates and restarts at the same first candidate", async () => {
    const listing = Buffer.concat(Array.from({ length: 177 }, (_, i) => Buffer.concat([
      Buffer.from(`<a href="book.asp?bkid=${i + 1}">116 `),
      Buffer.from("b0aaa6d2", "hex"),
      Buffer.from(` ${i + 1}</a>`)
    ])));
    const batches: string[][] = [];
    for (let run = 0; run < 2; run++) {
      const urls: string[] = [];
      const result = await runExamSnapshotCrawl({
        seeds: [{ group: "test", tier: "高考", kindId3: "1" }],
        delayMs: 0,
        fetcher: async (url) => {
          if (url.includes("layer.asp")) return { status: 200, body: listing };
          urls.push(url);
          return { status: 404, body: new Uint8Array() };
        }
      });
      expect(result.candidateLinks).toBe(177);
      expect(result.detailPagesFetched).toBe(120);
      batches.push(urls);
    }
    expect(batches[1]).toEqual(batches[0]);
  });
});

describe("persistent detail rotation", () => {
  it("covers 177 candidates in two runs and starts again on the third", async () => {
    const fetchedByUrl = new Map<string, number>();
    const listing = Buffer.concat(Array.from({ length: 177 }, (_, i) => Buffer.concat([
      Buffer.from(`<a href="book.asp?bkid=${i + 1}">116 `), Buffer.from("b0aaa6d2", "hex"), Buffer.from(` ${i + 1}</a>`)
    ])));
    const batches: string[][] = [];
    for (let run = 0; run < 3; run++) {
      const urls: string[] = [];
      const result = await runExamSnapshotCrawl({
        seeds: [{ group: "test", tier: "高考", kindId3: "1" }], delayMs: 0, fetchedByUrl,
        fetchedAt: new Date(1_800_000_000_000 + run * 1000).toISOString(),
        fetcher: async (url) => {
          if (url.includes("layer.asp")) return { status: 200, body: listing };
          urls.push(url);
          const id = new URL(url).searchParams.get("bkid");
          return { status: 200, body: Buffer.concat([Buffer.from("<title>116 test</title>"), Buffer.from("a169ab7eb8b9a16a", "hex"), Buffer.from(`C${id}`)]) };
        }
      });
      for (const record of result.records) fetchedByUrl.set(record.source_url, Date.parse(record.fetched_at));
      batches.push(urls);
    }
    expect(batches.map((batch) => batch.length)).toEqual([120, 120, 120]);
    expect(new Set([...batches[0], ...batches[1]]).size).toBe(177);
    expect(new Set(batches[2]).size).toBe(120);
  });

  it("prioritizes new and failed candidates and ignores removed ones", async () => {
    const fetchedByUrl = new Map<string, number>([
      ["https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=1", 100],
      ["https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=3", 100]
    ]);
    const listing = Buffer.concat([2, 3, 4].map((i) => Buffer.concat([
      Buffer.from(`<a href="book.asp?bkid=${i}">116 `), Buffer.from("b0aaa6d2", "hex"), Buffer.from(` ${i}</a>`)
    ])));
    const batches: string[][] = [];
    for (let run = 0; run < 2; run++) {
      const urls: string[] = [];
      const result = await runExamSnapshotCrawl({ seeds: [{ group: "test", tier: "高考", kindId3: "1" }], delayMs: 0, fetchedByUrl,
        fetcher: async (url) => {
          if (url.includes("layer.asp")) return { status: 200, body: listing };
          urls.push(url);
          const id = new URL(url).searchParams.get("bkid");
          if (id === "2" && run === 0) return { status: 500, body: new Uint8Array() };
          return { status: 200, body: Buffer.concat([Buffer.from("<title>116 test</title>"), Buffer.from("a169ab7eb8b9a16a", "hex"), Buffer.from(`C${id}`)]) };
        }
      });
      for (const record of result.records) fetchedByUrl.set(record.source_url, 200);
      batches.push(urls);
    }
    expect(batches[0].map((url) => new URL(url).searchParams.get("bkid"))).toEqual(["2", "4", "3"]);
    expect(batches[1].map((url) => new URL(url).searchParams.get("bkid"))).toEqual(["2", "3", "4"]);
  });
});


describe("rotation keeps moving past rejected pages", () => {
  it.each(["failed", "out-of-scope"])("covers 177 candidates despite a persistently %s page", async (kind) => {
    const seen = new Map<string, number>();
    const listing = Buffer.concat(Array.from({ length: 177 }, (_, i) => Buffer.concat([
      Buffer.from(`<a href="book.asp?bkid=${i + 1}">116 `), Buffer.from("b0aaa6d2", "hex"), Buffer.from(` ${i + 1}</a>`)
    ])));
    const all = new Set<string>();
    const batches: string[][] = [];
    let clock = 1;
    for (let round = 0; round < 4; round++) {
      const urls: string[] = [];
      await runExamSnapshotCrawl({ seeds: [{ group: "test", tier: "高考", kindId3: "1" }], delayMs: 0, fetchedByUrl: new Map(seen),
        onDetailAttempt: (url) => { seen.set(url, clock++); },
        fetcher: async (url) => {
          if (url.includes("layer.asp")) return { status: 200, body: listing };
          const id = new URL(url).searchParams.get("bkid")!;
          urls.push(id); all.add(id);
          if (id === "1") return kind === "failed" ? { status: 500, body: new Uint8Array() } : { status: 200, body: Buffer.from("<title>115 out of scope</title>") };
          return { status: 200, body: Buffer.concat([Buffer.from("<title>116 test</title>"), Buffer.from("a169ab7eb8b9a16a", "hex"), Buffer.from(`C${id}`)]) };
        }
      });
      batches.push(urls);
    }
    expect(batches.map((batch) => batch.length)).toEqual([120, 120, 120, 120]);
    expect(all.size).toBe(177);
    expect(batches.filter((batch) => batch.includes("1")).length).toBeGreaterThanOrEqual(3);
    expect(batches.every((batch) => batch.some((id) => id !== "1"))).toBe(true);
  });
});
