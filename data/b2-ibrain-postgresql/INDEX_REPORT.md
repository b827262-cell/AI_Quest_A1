# B2 PostgreSQL index report

- Exact identifier: `idx_exam_courses_course_code` supports `course_code` lookup.
- Keyword search: trigram GIN indexes cover `course_name` and `course_content`, including Chinese substring queries.
- Full text: a GIN expression index covers the combined `course_name` and `course_content` simple-language document.
- Filter: `exam_year` is a checked column (`115` or `116`) applied in both query contracts. No standalone index was added for it, so the search index scope remains course code/name/content only.
- No embedding, vector extension, vector table, or RAG fallback is present. `exam_courses` is the PostgreSQL source of truth; B1 JSON is import-only.
- Freshness: `UNVERIFIED`. This reflects the Owner checkpoint: B2 validates the supplied snapshot but does not perform a new live direct-fetch/DNS verification.
- Import status: unblocked. The B1 category hotfix canonicalized all 16 rows to `高普考` (published `高考`/`普考` tiers retained in `crawl-manifest.json` provenance) and recomputed `content_hash` under the declared recipe. Validation now passes end to end: the Node validator accepts 16/16 rows, and the repository validator reports `ok=true`, 0 errors, `categories=["高普考"]`, 16/16 reproducible hashes, 16 unique `(exam_year, course_code)` keys. The importer still fails closed on any non-canonical category, verified against a mutated in-memory fixture. Remaining warnings are `SOURCE_URL_CASE_INCONSISTENT` (path casing in the published URLs, deliberately untouched) and `DATA_FRESHNESS_UNVERIFIED`.
- Live import: not executed. `psql` requires `DATABASE_URL`; `--dry-run` produced the 16-row `jsonb_to_recordset` upsert and satisfies the `category = '高普考'` CHECK of `001_exam_courses.sql`.
