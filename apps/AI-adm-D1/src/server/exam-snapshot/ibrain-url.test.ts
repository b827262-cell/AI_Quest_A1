import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPageFetcher, runExamSnapshotCrawl } from "./ibrain-crawl";
import { parseListingCourseLinks } from "./ibrain-parse";
import { resolveIbrainUrl } from "./ibrain-url";

const listing = "https://ec.ibrain.com.tw/Publish/www/layer.asp?kind=1";
const label = "116 &#39640;&#32771; course";
const anchor = (href: string) => `<a href="${href}">${label}</a>`;

describe("iBrain URL resolution", () => {
  it.each([
    ["https://ec.ibrain.com.tw/book.asp?bkid=18185&x=1", "https://ec.ibrain.com.tw/book.asp?bkid=18185&x=1"],
    ["/Publish/www/book.asp?BKID=18185", "https://ec.ibrain.com.tw/Publish/www/book.asp?BKID=18185"],
    ["book.asp?bkid=18185&amp;x=one", "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18185&x=one"],
    ["book.asp?x=1&BkId=18185", "https://ec.ibrain.com.tw/Publish/www/book.asp?x=1&BkId=18185"]
  ])("resolves %s without losing query", (href, expected) => {
    expect(parseListingCourseLinks(anchor(href), listing)).toEqual([{ bkid: "18185", courseName: "116 高考 course", url: expected }]);
  });
  it.each(["https://evil.example/book.asp?bkid=1", "https://ec.ibrain.com.tw.evil.example/book.asp?bkid=1", "javascript:book.asp?bkid=1", "https://[invalid/book.asp?bkid=1", "", "https://ec.ibrain.com.tw@evil.example/book.asp?bkid=1"])("rejects unsafe or invalid href %s", (href) => {
    expect(parseListingCourseLinks(anchor(href), listing)).toEqual([]);
  });
  it("ignores a missing href", () => expect(parseListingCourseLinks(`<a>${label}</a>`, listing)).toEqual([]));
  it("rejects invalid protocols, hosts, and empty URLs directly", () => {
    for (const url of ["file:///book.asp?bkid=1", "https://evil.example/", "", "http://[invalid"]) expect(() => resolveIbrainUrl(url, listing)).toThrow();
  });
});

describe("safe fetching and mock crawl", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("rejects a cross-site redirect before making a second request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(defaultPageFetcher(listing)).rejects.toThrow(/off-whitelist/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects HTTPS downgrade before making a second request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://ec.ibrain.com.tw/book.asp?bkid=1" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(defaultPageFetcher(listing)).rejects.toThrow(/downgrade/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("fetches a 116 listing and detail with the complete URL", async () => {
    const urls: string[] = [];
    const bytes = (s: string) => new TextEncoder().encode(s);
    const result = await runExamSnapshotCrawl({ seeds: [{ group: "test", tier: "高考", kindId3: "1" }], delayMs: 0, fetchedAt: "2026-10-28T00:00:00.000Z", fetcher: async (url) => {
      urls.push(url);
      return { status: 200, body: bytes(url.includes("layer.asp") ? anchor("book.asp?BKID=18185&amp;x=1") : `<title>116 &#39640;&#32771; course</title><table><tr><td>&#12304;&#21697;&#34399;&#12305;</td><td>IPKKW126262</td></tr></table>`) };
    } });
    expect(urls[1]).toBe("https://ec.ibrain.com.tw/Publish/www/book.asp?BKID=18185&x=1");
    expect(result.failures).toEqual([]);
    expect(result.records).toMatchObject([{ exam_year: 116, course_code: "IPKKW126262", source_url: urls[1] }]);
  });
});
