-- All placeholders are PostgreSQL bind parameters. Database rows are the only
-- production search source; raw-snapshot.json is import input, never a fallback.

-- course_code exact match (case-insensitive), optionally constrained to 115/116.
SELECT exam_year, course_code, course_name, course_content, source_url
FROM public.exam_courses
WHERE lower(course_code) = lower($1)
  AND ($2::smallint IS NULL OR exam_year = $2)
ORDER BY exam_year DESC, course_name
LIMIT $3;

-- course_name/course_content keyword match. pg_trgm indexes support Chinese
-- substring search; the FTS predicate is available for tokenized queries.
SELECT exam_year, course_code, course_name, course_content, source_url
FROM public.exam_courses
WHERE ($1::smallint IS NULL OR exam_year = $1)
  AND (
    course_name ILIKE '%' || $2 || '%'
    OR course_content ILIKE '%' || $2 || '%'
    OR to_tsvector('simple', course_name || ' ' || course_content)
       @@ websearch_to_tsquery('simple', $2)
  )
ORDER BY exam_year DESC, course_name
LIMIT $3;
