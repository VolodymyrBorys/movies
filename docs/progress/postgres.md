# PostgreSQL — progress

_Started: 2026-11-19 · Roadmap: P0 step 9 (keyset plan), groundwork for P2/P3 · Code is the source of truth._

## Status

- ✅ Seed script `scripts/seed-movies.sql`: 1M synthetic movies, deterministic, idempotent, reversible.
- ✅ `EXPLAIN (ANALYZE, BUFFERS)` of the second-page keyset query on 1M rows: index scan with
  the row comparison as `Index Cond`, no `Sort`, 5 buffers (P0 step 9 done).
- ⏳ Findings to investigate in P3: half-empty `movies_created_at_id_idx`, `n_distinct` underestimate.

Local setup: PostgreSQL on the host (`brew services`), app DB `nebula` (primary only — the app
does not use the local replica, `PG_REPLICA_*` unset; see Drill log in `observability.md`).
`shared_buffers` not checked; the plans below suggest it is smaller than the 335 MB heap.

## Seed data (`scripts/seed-movies.sql`)

```bash
psql -d <db> -v rows=1000000 -f scripts/seed-movies.sql   # rows defaults to 1000000
```

psql, not pgAdmin (`VACUUM` cannot run in the transaction pgAdmin wraps a script in).
Design and rollback command: header of the script.

| Property | Why |
|---|---|
| `created_at` over 3 years, skewed to recent, microseconds | growing table; exercises cursor precision |
| every 50th row in a "bulk import" batch (1000 timestamps × ~20 rows, from 50k rows up) | `created_at` ties → keyset tie-break on `id` at page edges |
| inserted `ORDER BY created_at` | physical order follows time like an organic table (`correlation` ≈ 1) — affects index-scan costing |
| 1% `status`/`version` NULL | legacy rows the schema allows (P3 tightening) |
| ids `md5('movies-seed:' ‖ n)::uuid`, `setseed` | deterministic, `ON CONFLICT DO NOTHING` re-runs, exact rollback |
| outbox row in the same transaction | list cache invalidated by the worker, Redis untouched by hand |
| `VACUUM (ANALYZE)` at the end | fresh stats + visibility map; results don't depend on autovacuum timing |

Runs (owner, 2026-11-19, PostgreSQL on the host):

| DB | rows | INSERT | heap | `movies_created_at_id_idx` | `movies_pkey` | `created_at` correlation |
|---|---|---|---|---|---|---|
| `movies_test` | 10 000 | 130 ms | 3416 kB | 728 kB | 408 kB | 0.998 |
| `nebula` | 1 000 000 (+1 existing) | 11.7 s | 335 MB | 69 MB | 37 MB | 0.99998 |

~350 B per heap row. `id` correlation ≈ 0 (random-like uuids).

## Keyset vs OFFSET (1M rows, `sort=desc`, `limit=20` → `LIMIT 21`)

Second page — cursor = 20th row (`2026-11-19 01:59:59.973099+02`, `dc6d1027-…`), same SQL as
`movies.repository.ts` with literals:

```
Limit  (cost=0.42..3.73 rows=21 width=69) (actual time=0.035..0.075 rows=21 loops=1)
  Buffers: shared hit=5
  ->  Index Scan using movies_created_at_id_idx on movies  (cost=0.42..157122.87 rows=999583 width=69) (actual time=0.032..0.061 rows=21 loops=1)
        Index Cond: (ROW(created_at, id) < ROW('2026-11-19 01:59:59.973099+02'::timestamp with time zone, 'dc6d1027-0f34-043a-9ffc-3ea6ec310de6'::uuid))
        Buffers: shared hit=5
Planning Time: 0.325 ms
Execution Time: 0.114 ms
```

For comparison — `OFFSET 500000 LIMIT 21`, same order:

```
Limit  (cost=74844.35..74847.50 rows=21 width=37) (actual time=169.037..169.049 rows=21 loops=1)
  Buffers: shared hit=12758 read=25214 written=2
  ->  Index Scan using movies_created_at_id_idx on movies  (cost=0.42..149626.01 rows=999584 width=37) (actual time=0.113..156.413 rows=500021 loops=1)
        Buffers: shared hit=12758 read=25214 written=2
Execution Time: 169.079 ms
```

| | keyset, page 2 | OFFSET 500000 |
|---|---|---|
| rows read | 21 | 500 021 |
| buffers | 5 | ~38 000 (~300 MB) |
| time, cold → warm | 9.6 ms → **0.11 ms** | 575 ms → **169 ms** |

What it shows:

- Row comparison `(created_at, id) < (…)` is an **`Index Cond`** (not a `Filter`), and the
  index order matches `ORDER BY` → no `Sort`, the scan stops after 21 rows. Cost does not
  grow with page depth.
- `OFFSET` has no skip: all 500 000 preceding rows are fetched from the heap and discarded;
  buffers and time grow linearly with depth.
- Cold keyset run: 9.5 ms of 9.6 ms was waiting for 2 uncached pages (`read=2`); CPU part ~0.1 ms.
  Buffers are the cache-independent measure.
- `Index Scan`, not `Index Only Scan`: the query needs `status`/`version`.
- First `OFFSET` run had `written=2484`: the backend flushed dirty buffers left by the seed to
  free space; second run `written=2` (hypothesis confirmed: a read query can write). Second
  run still `read=25214` while time dropped 575 → 169 ms → pages came from the OS page cache,
  i.e. `shared_buffers` < working set (hypothesis, not checked).
- `rows=999583` on the Index Scan node is the estimate without `LIMIT`; the `Limit` cost
  (3.73) already accounts for stopping early.

## Findings for P3

1. **`movies_created_at_id_idx` is ~52% full.** 1M × ~36 B (8 timestamptz + 16 uuid + 8 tuple
   header + 4 line pointer) ≈ 36 MB minimum vs 69 MB actual (10k rows: 728 kB vs ~360 kB).
   New rows have the newest `created_at` = the **leftmost** leaf of a `DESC` index; page
   splits there leave half-empty pages (the 90% "rightmost split" fill applies only to the
   right edge — hypothesis about the mechanism). Production inserts follow the same pattern,
   so this is realistic. Experiments: an `ASC` index (backward scan serves `DESC` order),
   `REINDEX`, `pgstattuple`/`pgstatindex` for `avg_leaf_density`; compare size and buffers.
   `movies_pkey` (random uuids): 37 MB vs ~28 MB minimum, ~76%.
2. **`n_distinct` for `created_at` underestimated:** ANALYZE −0.74 (~74% distinct) vs actual
   981 001 / 1 000 001 (98.1%). Sample-based estimate (default statistics target 100 →
   30 000 sampled rows). Irrelevant for the keyset query; matters for `GROUP BY`/joins on
   `created_at`. Experiment: `ALTER TABLE movies ALTER COLUMN created_at SET STATISTICS 1000`,
   `ANALYZE`, compare.
3. `shared_buffers` vs working set: check the setting; relevant for P2 load numbers.
