import { resolve } from "node:path";
import { runExamSnapshotCrawl, EXAM_SNAPSHOT_SEEDS } from "../apps/AI-adm-D1/src/server/exam-snapshot/ibrain-crawl";
import { loadSnapshot, taipeiDate, writeSnapshot } from "../apps/AI-adm-D1/src/server/exam-snapshot/snapshot-store";

/**
 * B1: bounded 115/116 高普考 snapshot of ec.ibrain.com.tw public course pages.
 * Writes data/snapshots/ibrain/<date>/courses.jsonl + manifest.json and never
 * touches an older snapshot directory.
 *
 *   pnpm db:snapshot:exam -- --max-detail-pages=40 --snapshot-date=2026-10-03
 */
const repoRoot = resolve(import.meta.dirname, "..");
const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);

const snapshotDate = arg("snapshot-date") ?? taipeiDate();
const maxDetailPages = Number(arg("max-detail-pages") ?? "80");
const delayMs = Number(arg("delay-ms") ?? "80");
const dryRun = process.argv.includes("--dry-run");

const crawl = await runExamSnapshotCrawl({
  maxDetailPages: Number.isFinite(maxDetailPages) ? maxDetailPages : 80,
  delayMs: Number.isFinite(delayMs) ? delayMs : 80,
  onProgress: (message) => console.log(`[exam-snapshot] ${message}`)
});

const written = dryRun
  ? { directory: "(dry run)", rawPath: "(dry run)", manifestPath: "(dry run)", manifest: null }
  : writeSnapshot({
      root: repoRoot,
      snapshotDate,
      records: crawl.records,
      failures: crawl.failures,
      crawl: {
        listing_pages_fetched: crawl.listingPagesFetched,
        candidate_links: crawl.candidateLinks,
        detail_pages_fetched: crawl.detailPagesFetched,
        skipped_out_of_scope: crawl.skippedOutOfScope
      },
      seedPages: EXAM_SNAPSHOT_SEEDS.length
    });

console.log(`[exam-snapshot] snapshot_date=${snapshotDate}`);
console.log(`[exam-snapshot] directory=${written.directory}`);
console.log(`[exam-snapshot] records=${crawl.records.length} listings=${crawl.listingPagesFetched}/${EXAM_SNAPSHOT_SEEDS.length} candidates=${crawl.candidateLinks} details=${crawl.detailPagesFetched} skipped=${crawl.skippedOutOfScope}`);
console.log(`[exam-snapshot] failures=${crawl.failures.length}`);
for (const failure of crawl.failures.slice(0, 20)) {
  console.log(`[exam-snapshot] FAILED ${failure.stage} ${failure.url} status=${failure.status ?? "-"} reason=${failure.reason}`);
}

if (!dryRun) {
  const loaded = loadSnapshot({ root: repoRoot, snapshotDate });
  console.log(`[exam-snapshot] verified readback: ${loaded?.records.length ?? 0} records, manifest=${loaded?.manifest ? "yes" : "no"}`);
  if (!loaded || loaded.records.length !== crawl.records.length) {
    console.error("[exam-snapshot] readback mismatch");
    process.exit(1);
  }
}
