-- Issue #72: reviewable SQLite migration; production execution remains gated.
-- Runtime runMigrations carries the same idempotent statements for local databases.
CREATE TABLE IF NOT EXISTS student_learning_history (
  student_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  asked_at TEXT NOT NULL,
  question TEXT NOT NULL,
  category TEXT NOT NULL,
  source_type TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK(strategy IN ('google-ai','api')),
  answer TEXT,
  answer_updated_at TEXT,
  raw_answer TEXT,
  raw_answer_captured_at TEXT,
  source_url TEXT,
  organized_answer TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  sync_version INTEGER NOT NULL CHECK(sync_version > 0),
  PRIMARY KEY(student_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_student_learning_history_asked
  ON student_learning_history(student_id, asked_at DESC);
