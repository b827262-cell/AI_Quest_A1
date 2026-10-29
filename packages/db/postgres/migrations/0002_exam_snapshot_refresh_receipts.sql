-- Durable idempotency and status for admin exam snapshot refresh jobs.
CREATE TABLE IF NOT EXISTS exam_snapshot_refresh_receipts (
  idempotency_key TEXT PRIMARY KEY,
  exam_year SMALLINT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  response JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
