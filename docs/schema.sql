-- Distributed Code Execution Engine — Database Schema (v2)
-- Run once to initialise: psql -U postgres -d code_exec -f docs/schema.sql
-- Or via Docker Compose: mounted as /docker-entrypoint-initdb.d/schema.sql

-- =============================================================================
-- v1 Schema (base tables — unchanged)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS submissions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status       TEXT NOT NULL DEFAULT 'pending',
  -- pending → running → done | failed | timeout
  language     TEXT NOT NULL DEFAULT 'python',
  -- python | javascript | cpp
  user_ip      TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

CREATE TABLE IF NOT EXISTS execution_results (
  submission_id  UUID PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
  stdout         TEXT,
  stderr         TEXT,
  exit_code      INTEGER,
  runtime_ms     INTEGER,
  timed_out      BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- =============================================================================
-- v2 Schema Deltas
-- Apply these if upgrading an existing v1 database.
-- Already included above in a fresh install — idempotent via IF NOT EXISTS pattern.
-- =============================================================================

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS request_id   UUID,
  ADD COLUMN IF NOT EXISTS retry_count  INTEGER DEFAULT 0;
  -- language column already existed in v1

ALTER TABLE execution_results
  ADD COLUMN IF NOT EXISTS compile_stdout  TEXT,     -- populated only for C++ (compile phase stdout)
  ADD COLUMN IF NOT EXISTS compile_stderr  TEXT,     -- populated only for C++ (compile phase stderr)
  ADD COLUMN IF NOT EXISTS killed_by       TEXT;     -- 'timeout' | 'oom' | null

-- Index for watchdog queries — find jobs stuck in 'running' efficiently
CREATE INDEX IF NOT EXISTS idx_submissions_status_created
  ON submissions(status, created_at)
  WHERE status = 'running';