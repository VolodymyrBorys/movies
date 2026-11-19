-- Seed `movies` with a production-like volume for plan / load experiments (roadmap P2/P3).
-- LAB: synthetic data — production would also have real skew in titles/descriptions and
-- an update history (dead tuples, HOT chains); PATCH load in P2 adds the latter.
--
-- Run with psql (not pgAdmin: VACUUM cannot run inside the implicit transaction pgAdmin
-- wraps a multi-statement script in):
--   psql -d <db> -v rows=1000000 -f scripts/seed-movies.sql
-- `rows` defaults to 1000000. Writes to PostgreSQL (and WAL → replica): run on purpose.
--
-- Properties:
-- * Deterministic: setseed() + ids = md5('movies-seed:' || n)::uuid → same data every run.
-- * Idempotent: ON CONFLICT (id) DO NOTHING; re-running adds nothing.
-- * Reversible (exact rows only, nothing else touched):
--     DELETE FROM movies
--     WHERE id IN (SELECT md5('movies-seed:' || n)::uuid FROM generate_series(1, 1000000) n);
--     VACUUM (ANALYZE) movies;
-- * created_at: last 3 years, skewed towards recent (growth), microsecond precision.
--   Every 50th row belongs to a "bulk import" batch: 1000 timestamps × ~20 rows each,
--   so (created_at) ties exist and the keyset tie-break on id is exercised at page edges.
-- * Inserted ORDER BY created_at: physical order follows time like an organically grown
--   table (pg_stats.correlation ≈ ±1). Random insert order would make index scans look
--   more expensive to the planner than in production.
-- * 1% "legacy" rows: status 'draft', version 1. They used to be NULL; since migrations
--   *_movies_status_version_{backfill,not_null}.sql both columns are NOT NULL and the
--   backfill wrote exactly these values, so a DB seeded before the migration and one
--   seeded after it hold the same data.

\set ON_ERROR_STOP on
\timing on

\if :{?rows}
\else
  \set rows 1000000
\endif

SELECT current_database() AS db, inet_server_addr() AS host, inet_server_port() AS port,
       (SELECT count(*) FROM movies) AS rows_before;

BEGIN;

-- Deterministic random() for this session (affects only this transaction's statements).
SELECT setseed(0.42);

INSERT INTO movies (id, title, description, release_year, duration_minutes, created_at, status, version)
SELECT id, title, description, release_year, duration_minutes, created_at, status, version
FROM (
  SELECT
    md5('movies-seed:' || n)::uuid AS id,
    (ARRAY['The','Last','Silent','Red','Lost','Midnight','Golden','Broken','Hidden','Final'])[1 + floor(random() * 10)::int]
      || ' '
      || (ARRAY['City','River','Signal','Garden','Empire','Voyage','Code','Winter','Archive','Horizon'])[1 + floor(random() * 10)::int]
      || ' ' || n AS title,
    CASE WHEN random() < 0.10 THEN NULL
         ELSE left(repeat('A story about people, places and the choices that change them. ', 10),
                   50 + floor(random() * 450)::int)
    END AS description,
    (1950 + floor(random() * 77))::smallint AS release_year,
    (70 + floor(random() * 131))::smallint AS duration_minutes,
    CASE WHEN n % 50 = 0
         -- bulk-import batch: whole-second timestamps shared by ~20 rows
         THEN timestamptz '2026-11-19 00:00:00+00' - make_interval(secs => 86400 * (1 + (n / 50) % 1000))
         -- regular row: power(random(), 2) puts more rows near the end of the range
         ELSE timestamptz '2026-11-19 00:00:00+00' - make_interval(secs => 94608000 * power(random(), 2))
    END AS created_at,
    CASE WHEN r_status < 0.01 THEN 'draft' -- legacy rows: the backfill value
         WHEN r_status < 0.71 THEN 'published'
         WHEN r_status < 0.91 THEN 'draft'
         ELSE 'archived'
    END AS status,
    CASE WHEN r_status < 0.01 THEN 1 -- legacy rows: the backfill value
         ELSE 1 + floor(power(random(), 3) * 5)::int
    END AS version
  -- One random() per row for status, so status and version agree on the legacy 1%.
  -- (A subquery with a volatile function is not flattened → evaluated per row.)
  FROM (SELECT n, random() AS r_status FROM generate_series(1, :rows) AS n) AS g
) AS seed
ORDER BY created_at
ON CONFLICT (id) DO NOTHING;

-- Invalidate the list cache through the system's own mechanism (same transaction as the
-- data, picked up by the outbox worker), instead of touching Redis by hand.
INSERT INTO cache_invalidation_outbox (aggregate_type, aggregate_id, event_type)
VALUES ('movie', 'seed', 'movies.list.invalidate');

COMMIT;

-- Outside the transaction: fresh planner statistics + visibility map (index-only scans).
-- Autovacuum would get there eventually; experiments shouldn't depend on when.
VACUUM (ANALYZE) movies;

SELECT count(*) AS rows_after,
       pg_size_pretty(pg_relation_size('movies')) AS heap,
       pg_size_pretty(pg_relation_size('movies_created_at_id_idx')) AS created_at_idx,
       pg_size_pretty(pg_relation_size('movies_pkey')) AS pkey
FROM movies;

SELECT attname, n_distinct, correlation
FROM pg_stats
WHERE tablename = 'movies' AND attname IN ('created_at', 'id', 'status');
