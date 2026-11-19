-- Up Migration

-- EXPAND step of tightening movies.status / movies.version (roadmap P3, step C4).
-- Compatible with the running app: it writes only 'draft'|'published'|'archived' and a
-- non-NULL version (Zod enum on POST/PATCH since the same change).
-- Requires scripts/migrate.ts `singleTransaction: false`, so the ACCESS EXCLUSIVE lock below
-- is released at THIS migration's commit, before the next one scans the table.

-- 1) Backfill first, while holding only ROW EXCLUSIVE: reads and writes keep running.
--    One UPDATE for both columns → one new tuple version per affected row, not two.
UPDATE movies
SET status  = COALESCE(status, 'draft'),
    version = COALESCE(version, 1)
WHERE status IS NULL OR version IS NULL;

-- 2) Metadata only (no table scan, no rewrite): ACCESS EXCLUSIVE held briefly until commit.
--    NOT VALID: every NEW insert/update is checked from now on; existing rows are scanned
--    later by VALIDATE CONSTRAINT under a weaker lock (next migration).
ALTER TABLE movies
  ALTER COLUMN status  SET DEFAULT 'draft',
  ALTER COLUMN version SET DEFAULT 1,
  ADD CONSTRAINT movies_status_valid     CHECK (status IN ('draft', 'published', 'archived')) NOT VALID,
  ADD CONSTRAINT movies_status_not_null  CHECK (status IS NOT NULL) NOT VALID,
  ADD CONSTRAINT movies_version_not_null CHECK (version IS NOT NULL) NOT VALID;

-- Down Migration

-- Schema only. The backfill is NOT reversed: which rows were NULL is not recorded.
ALTER TABLE movies
  DROP CONSTRAINT movies_version_not_null,
  DROP CONSTRAINT movies_status_not_null,
  DROP CONSTRAINT movies_status_valid,
  ALTER COLUMN version DROP DEFAULT,
  ALTER COLUMN status  DROP DEFAULT;
