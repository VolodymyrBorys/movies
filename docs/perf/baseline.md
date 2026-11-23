# Performance baseline (P2)

_Started: 2026-11-22 · Branch `p2-k6-baseline` · Scope of this step: P2.0 smoke, P2.1 cached reads, P2.2 cold reads._
_Status: **P2.0 smoke passed** (2026-11-22); P2.1 cached 100–1600 req/s done, k6 side only (2026-11-23); 3200+, P2.2 and P2.3+ deferred by the owner in favour of P5 (k6 is run by the owner; the assistant sandbox can't reach local ports)._

## What these numbers are (and are not)

- k6, the API, PostgreSQL, Redis and the observability stack run **on one laptop** and compete for CPU. Results are **relative**: which resource gives out first, how latency behaves past the knee, before/after comparisons. They are **not** per-pod capacity (that needs separate hosts: P9/P11).
- Open model (`constant-arrival-rate`): the offered rate doesn't drop when the server slows down, so tail latency isn't hidden (coordinated omission). A run with `dropped_iterations > 0` didn't reach its rate → invalid (k6 was the bottleneck, or `MAX_VUS` too low).
- Writes: none in P2.0–P2.2. RAG endpoints are never load-tested (billable).

## Setup (owner)

1. k6 installed: `k6 v2.4.0` (Homebrew, 2026-11-22). Types: `@types/k6@2.3.1` (devDependency, exact).
2. Start PostgreSQL, Redis and the observability stack (`npm run obs:up`).
3. Start the API **without** `--watch` and without logs in the terminal (pino-http logs every request at `info`; printing them to a terminal costs far more than writing to a file):
   ```
   node --env-file-if-exists=.env src/server.ts > "$TMPDIR/movies-api.log" 2>&1
   ```
   Keep `LOG_LEVEL` as it is in `.env` (request logging is part of the real cost; turning it off is a separate experiment).
4. Note the machine: CPU model / cores, RAM, `PG_POOL_MAX` (default 10), Node version.

## Runs

All commands from the repo root. Scenarios are TypeScript (`load/k6/*.ts`): k6 v2 runs them directly; type check with `npx tsc -p load/k6` (needs `@types/k6`). Parameters go through `-e NAME=value` (`k6 inspect` ignores shell env vars; `-e` works for every command). `k6 inspect -e RATE=… load/k6/<scenario>.ts` shows the resolved options without sending requests. Every run writes `docs/perf/runs/<UTC time>-<scenario>-<RUN_LABEL>.json` (full k6 summary + params + Prometheus window `measuredFrom .. finishedAt`) and prints a compact summary. Exit code 99 = a threshold failed (expected past the knee).

### P2.0 smoke

```
k6 run load/k6/smoke.ts
```
Pass: all checks 100%, no failed requests. Then check Grafana shows the traffic.

Result (owner, 2026-11-22 18:07Z): 180 requests, failed 0%, checks 100%, p95 7.97 ms, p99 22.46 ms, dropped 0 → `runs/2026-11-22T18-07-55-311Z-smoke.json`. Earlier failed runs: `/readyz` 503 `shuttingDown: true` because the API ran under `npm run dev` (`--watch`) — use the command from Setup step 3.

### P2.1 cached reads (stairs)

One rate per run, 2 min each (Prometheus scrapes every 15 s → ≥ 8 points per step):
```
for r in 100 200 400 800 1600; do
  k6 run -e RATE=$r -e DURATION=2m -e RUN_LABEL=r$r load/k6/read-cached.ts; sleep 30
done
```
Stop climbing when p99 > 250 ms, errors > 0.5% or `dropped_iterations > 0`; then bisect between the last good and the first bad rate. If k6 runs out of VUs: `-e MAX_VUS=<n>` (VUs needed ≈ rate × latency in seconds).

### P2.2 cold reads

```
for r in 50 100 200 400; do
  k6 run -e RATE=$r -e DURATION=2m -e RUN_LABEL=r$r load/k6/read-cold.ts; sleep 90
done
```
- `setup()` walks 2000 pages (`limit=100`) before the measured part; the script refuses to start when `RATE × DURATION` exceeds the unique keys (2000 × 50 = 100 000) — raise `COLD_CURSOR_PAGES` for longer/faster runs.
- `sleep 90` > list TTL (60 s + jitter): the previous run's keys expire, so repeating the same rate is cold again without `FLUSHDB`.
- Valid only if cache hits stay ~0 during the window (query below).

### Repeatability

Each rate near the knee: 3 runs (`RUN_LABEL=r400-1`, `-2`, `-3`). Agreed variance (hypothesis, revisit after the first runs): p95 within ±10% across runs.

## Server-side queries (Prometheus, window = `measuredFrom .. finishedAt` of the run)

| Signal | PromQL |
|---|---|
| Throughput | `sum(rate(http_requests_total{job="movies-api",route="/v1/movies"}[1m]))` |
| p99 (from buckets, interpolated) | `histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job="movies-api",route="/v1/movies"}[1m])))` |
| Share ≤ 250 ms (exact at the bucket edge) | `sum(rate(http_request_duration_seconds_bucket{job="movies-api",route="/v1/movies",le="0.25"}[1m])) / sum(rate(http_request_duration_seconds_count{job="movies-api",route="/v1/movies"}[1m]))` |
| 5xx ratio | `sum(rate(http_requests_total{job="movies-api",route="/v1/movies",status_code=~"5.."}[1m])) / sum(rate(http_requests_total{job="movies-api",route="/v1/movies"}[1m]))` |
| Cache results | `sum by (result) (rate(cache_requests_total{job="movies-api",cache="movies_list"}[1m]))` |
| PG pool | `max by (pool, state) (pg_pool_connections{job="movies-api"})` |
| Event loop lag p99 | `max(nodejs_nodejs_eventloop_lag_p99_seconds{job="movies-api"})` |
| API process CPU (1.0 = one core) | `rate(nodejs_process_cpu_seconds_total{job="movies-api"}[1m])` |
| API memory | `nodejs_process_resident_memory_bytes{job="movies-api"}` |
| PostgreSQL activity | `sum by (state) (pg_stat_activity_count)` (postgres_exporter) |
| Redis commands/s | `rate(redis_commands_processed_total[1m])` |

Notes: k6 p99 vs `histogram_quantile` differ by up to a bucket width (buckets 0.1 / 0.25 / 0.5 s) — expected, not a bug. Server-side latency excludes network/queueing in k6; a growing gap between the two = time spent before the handler (accept queue, event loop). The HTTP histogram ends at 5 s: a server-side p99 above that is not measurable; k6 still sees it. No host CPU exporter: watch PostgreSQL / k6 CPU in Activity Monitor or `top` during the run and write it down.

## Results

_Machine:_ … · _k6:_ v2.4.0 · _Node:_ v26.13.1 (assistant's shell; confirm) · _PG_POOL_MAX:_ … · _Dataset:_ 1M movies (`nebula`)

### P2.1 cached

| Rate (req/s) | Achieved | p50 ms | p95 ms | p99 ms | Failed % | Dropped | Cache hit % | API CPU | EL lag p99 | Pool waiting |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 99.98 | 1.33 | 2.11 | 4.00 | 0 | 0 | — | — | — | — |
| 200 | 199.95 | 1.12 | 1.71 | 2.73 | 0 | 0 | — | — | — | — |
| 400 | 399.93 | 0.94 | 1.49 | 2.50 | 0 | 0 | — | — | — | — |
| 800 | 799.83 | 0.52 | 0.94 | 1.78 | 0 | 0 | — | — | — | — |
| 1600 | 1599.78 | 0.31 | 0.47 | 1.59 | 0 | 0 | — | — | — | — |

Owner, 2026-11-23 (runs `runs/2026-11-23T*-read-cached*.json`; r100 has no `RUN_LABEL`). k6 side only: server-side columns were not collected (`—`). Cache: `cache_requests_total{cache="movies_list",result="miss"}` = 92 at the end — a cumulative counter since API start (includes smoke/warm-up), so not attributable per run; vs ~372k stair requests the hit ratio was ≈ 99.98% (approximate). No knee up to 1600 req/s; max latency grew 36 → 80 ms while p99 stayed < 3 ms.

### P2.2 cold

| Rate (req/s) | Achieved | p50 ms | p95 ms | p99 ms | Failed % | Dropped | Cache hit % | API CPU | EL lag p99 | Pool waiting |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

### Findings

- Cached path: no knee up to 1600 req/s (all thresholds green, `vus_max` ≤ 160). Higher rates (3200+), P2.2 cold and P2.3–P2.8 **deferred by the owner (2026-11-23)** in favour of P5.
- Surprise: latency **falls** as the rate rises (p50 1.33 → 0.31 ms). Hypotheses, not verified: macOS CPU power management (idle cores clock down / wake-up cost at low rates) and the Node event loop sleeping between sparse requests. Consequence: compare only runs at the same rate on this laptop.
- `max` grows with rate (36 → 80 ms) while p99 is flat. Hypotheses: GC pauses, or the ~60 s TTL expiry of the single cache key (concurrent misses). Check: `cache_requests_total{result="miss"}` steps over the run window.

## Next (not in this step)

P2.3 mixed read/write (PATCH with `If-Match` on rows created/deleted by the test — owner decision 2026-11-22), P2.4 `PG_POOL_MAX` 2/10/50, P2.5 version-bump miss storm, P2.6 spike, P2.7 soak 1 h, P2.8 report + alert thresholds. k6 → Prometheus remote write: not now (owner, 2026-11-22; needs a compose flag).
