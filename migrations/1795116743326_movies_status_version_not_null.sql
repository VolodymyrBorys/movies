-- Up Migration

-- CONTRACT step: make movies.status / movies.version NOT NULL without a long
-- ACCESS EXCLUSIVE lock (previous migration added the CHECKs as NOT VALID).

-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE: it scans the whole table, but
-- SELECT/INSERT/UPDATE/DELETE keep running. Fails if any row violates the CHECK (e.g. a
-- status outside the enum) — fix the data, then rerun; nothing is silently remapped.
ALTER TABLE movies VALIDATE CONSTRAINT movies_status_valid;
ALTER TABLE movies VALIDATE CONSTRAINT movies_status_not_null;
ALTER TABLE movies VALIDATE CONSTRAINT movies_version_not_null;

-- PostgreSQL 12+: a VALID CHECK (col IS NOT NULL) proves there are no NULLs, so SET NOT NULL
-- skips the full-table scan (DEBUG1: "existing constraints on column ... are sufficient to
-- prove that it does not contain nulls"). ACCESS EXCLUSIVE is held only for metadata.
-- Not yet verified on PostgreSQL 18 (NOT NULL became a pg_constraint entry there).
ALTER TABLE movies
  ALTER COLUMN status  SET NOT NULL,
  ALTER COLUMN version SET NOT NULL;

-- Separate statement on purpose: ALTER TABLE runs subcommands in passes and DROP comes
-- first, so dropping the helper CHECKs in the statement above would remove the proof
-- before SET NOT NULL looks for it → full scan under ACCESS EXCLUSIVE.
ALTER TABLE movies
  DROP CONSTRAINT movies_status_not_null,
  DROP CONSTRAINT movies_version_not_null;

-- Down Migration

-- Back to the state after the expand migration (nullable columns, NOT VALID helper CHECKs).
ALTER TABLE movies
  ALTER COLUMN status  DROP NOT NULL,
  ALTER COLUMN version DROP NOT NULL,
  ADD CONSTRAINT movies_status_not_null  CHECK (status IS NOT NULL) NOT VALID,
  ADD CONSTRAINT movies_version_not_null CHECK (version IS NOT NULL) NOT VALID;
