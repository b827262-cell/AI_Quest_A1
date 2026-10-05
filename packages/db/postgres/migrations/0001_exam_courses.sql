-- A-01 / B2 — 高普考 course snapshot: PostgreSQL schema of record.
--
-- data/b1-ibrain-public/raw-snapshot.json is an *input artifact* of the crawl
-- only. From this migration forward exam_courses is the single source of truth
-- for every course lookup, and the crawl is re-applied as an idempotent upsert
-- keyed on (exam_year, course_code) with content_hash deciding whether a row
-- actually changed.
--
-- Index surface is deliberately limited to the three searchable columns named
-- in the B2 contract (course_code, course_name, course_content). There is no
-- vector column, no embedding, no ANN/GiST-on-vector operator class and no
-- similarity function: keyword search is substring + PostgreSQL full text only.

BEGIN;

-- pg_trgm is PostgreSQL contrib, shipped with the server. It is required
-- because course text is CJK: to_tsvector('simple') cannot segment Chinese,
-- so it indexes latin tokens (course codes, year numbers) only. Trigram GIN
-- is what actually serves `ILIKE '%keyword%'` over 統計學/全修課程 text.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS exam_course_schema_migrations (
  version    TEXT        NOT NULL PRIMARY KEY,
  name       TEXT        NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE exam_course_schema_migrations IS
  'Applied-version ledger for the exam-course PostgreSQL schema only; it does not track the SQLite application migrations in src/migrate.ts.';

CREATE TABLE IF NOT EXISTS exam_courses (
  -- Natural key: one course code exists at most once per exam year. This is the
  -- "同一年度同一課程不可重複寫入" rule, enforced by the primary key itself so
  -- there is no second, divergent uniqueness definition.
  exam_year      SMALLINT    NOT NULL,
  course_code    TEXT        NOT NULL,
  category       TEXT        NOT NULL,
  course_name    TEXT        NOT NULL,
  course_content TEXT        NOT NULL DEFAULT '',
  teacher        TEXT        NULL,
  applicable_scope TEXT      NULL,
  source_url     TEXT        NOT NULL,

  -- sha256 over the source-visible fields (fetched_at excluded). The upsert
  -- compares this column to decide insert / update / no-op.
  content_hash   TEXT        NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL,

  revision       INTEGER     NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (exam_year, course_code),

  CONSTRAINT exam_courses_exam_year_allowed
    CHECK (exam_year IN (115, 116)),
  CONSTRAINT exam_courses_category_allowed
    CHECK (category = '高普考'),
  -- Uppercase-only identifiers are what let the query layer upper-case the
  -- *parameter* instead of wrapping the column, keeping exact code lookups on
  -- the primary key while still matching case-insensitively on input.
  CONSTRAINT exam_courses_course_code_shape
    CHECK (course_code ~ '^[A-Z0-9][A-Z0-9._-]{0,127}$'),
  CONSTRAINT exam_courses_course_name_shape
    CHECK (length(course_name) BETWEEN 1 AND 512),
  CONSTRAINT exam_courses_course_content_shape
    CHECK (length(course_content) <= 20000),
  CONSTRAINT exam_courses_source_url_shape
    CHECK (length(source_url) BETWEEN 1 AND 2048),
  -- The crawl contract allows exactly one host. Encoding it here means a bad
  -- base URL can never enter the source-of-truth table, not even by hand. The
  -- host boundary rejects suffixes and userinfo; path case stays unrestricted
  -- because the published source uses mixed-case paths.
  CONSTRAINT exam_courses_source_url_host
    CHECK (source_url ~ '^https?://ec\.ibrain\.com\.tw([/?#]|$)'),
  CONSTRAINT exam_courses_content_hash_sha256
    CHECK (content_hash ~ '^[a-f0-9]{64}$')
);

COMMENT ON TABLE exam_courses IS
  'B2 source of truth for 高普考 115/116 courses crawled from ec.ibrain.com.tw.';
COMMENT ON COLUMN exam_courses.revision IS
  'Incremented only when content_hash changed; a re-crawl of unchanged content leaves revision untouched.';
COMMENT ON COLUMN exam_courses.fetched_at IS
  'Source crawl timestamp. DB mutation time is created_at/updated_at, never fetched_at.';

-- course_code exact lookup is served by the (exam_year, course_code) primary
-- key; the trigram index below additionally serves course_code substring and
-- prefix matching without adding a searchable column outside the contract.
CREATE INDEX IF NOT EXISTS exam_courses_course_code_trgm
  ON exam_courses USING gin (course_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS exam_courses_course_name_trgm
  ON exam_courses USING gin (course_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS exam_courses_course_content_trgm
  ON exam_courses USING gin (course_content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS exam_courses_teacher_trgm
  ON exam_courses USING gin (teacher gin_trgm_ops);
CREATE INDEX IF NOT EXISTS exam_courses_applicable_scope_trgm
  ON exam_courses USING gin (applicable_scope gin_trgm_ops);

-- Full text over name + content. The expression must match the query
-- expression in src/exam/exam-course.repo.ts verbatim or the planner cannot
-- use this index.
CREATE INDEX IF NOT EXISTS exam_courses_search_fts
  ON exam_courses USING gin (to_tsvector('simple', course_name || ' ' || course_content));

-- No dedicated exam_year index: it is the leading column of the primary key,
-- so `WHERE exam_year = 116` already has an ordered, indexable path.

INSERT INTO exam_course_schema_migrations (version, name)
VALUES ('0001', '0001_exam_courses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
