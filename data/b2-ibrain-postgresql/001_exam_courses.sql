-- B2 authoritative PostgreSQL store for the B1 public course snapshot.
-- Additive and repeatable: this migration deliberately has no destructive down path.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.exam_courses (
  exam_year SMALLINT NOT NULL CHECK (exam_year IN (115, 116)),
  category TEXT NOT NULL CHECK (category = '高普考'),
  -- This natural key and uppercase invariant match the canonical PostgreSQL
  -- schema. Do not introduce a second, expression-based uniqueness rule.
  course_code TEXT NOT NULL CHECK (course_code ~ '^[A-Z0-9][A-Z0-9._-]{0,127}$'),
  course_name TEXT NOT NULL CHECK (btrim(course_name) <> ''),
  course_content TEXT NOT NULL,
  teacher TEXT NULL,
  applicable_scope TEXT NULL,
  -- The host boundary prevents suffixes and userinfo from matching. Path case
  -- is deliberately unconstrained because published B1 URLs use mixed casing.
  source_url TEXT NOT NULL CHECK (
    length(source_url) BETWEEN 1 AND 2048
    AND source_url ~ '^https?://ec\.ibrain\.com\.tw([/?#]|$)'
  ),
  fetched_at TIMESTAMPTZ NOT NULL,
  content_hash CHAR(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (exam_year, course_code)
);

-- The allowed search surface covers course_code, course_name, content, teacher, and applicable_scope.
CREATE INDEX IF NOT EXISTS idx_exam_courses_course_code
  ON public.exam_courses (course_code);
CREATE INDEX IF NOT EXISTS idx_exam_courses_course_name_trgm
  ON public.exam_courses USING GIN (course_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_exam_courses_course_content_trgm
  ON public.exam_courses USING GIN (course_content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_exam_courses_teacher_trgm
  ON public.exam_courses USING GIN (teacher gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_exam_courses_applicable_scope_trgm
  ON public.exam_courses USING GIN (applicable_scope gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_exam_courses_name_content_fts
  ON public.exam_courses USING GIN (to_tsvector('simple', course_name || ' ' || course_content));

COMMENT ON TABLE public.exam_courses IS
  'Authoritative B2 PostgreSQL mirror of B1 public 高普考 115/116 courses; no vector/RAG data.';
COMMENT ON COLUMN public.exam_courses.content_hash IS
  'SHA-256 of B1 canonical course fields; unchanged content is not rewritten by the importer.';
