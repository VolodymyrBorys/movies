# Observability — progress and runbooks

_Started: 2026-11-17 · Roadmap phase P1 · Code and config are the source of truth._

## What runs where

| Component | Where | URL |
|---|---|---|
| Movies API (`npm run dev`) | host | `http://localhost:3000/v1/metrics` |
| Worker (`npm run worker`, P5.5) | host | `http://localhost:3002/metrics` |
| RabbitMQ (Homebrew) | host | `http://localhost:15692/metrics` (aggregated), `/metrics/detailed?vhost=/&family=…` (per queue) |
| PostgreSQL, Redis | host | — |
| Prometheus | compose | http://localhost:9090 |
| Alertmanager | compose (no external receivers) | http://localhost:9093 |
| Grafana (dashboard "Movies API") | compose | http://localhost:3001 |
| postgres_exporter, redis_exporter | compose, internal network only | scraped by Prometheus |

All ports bind to `127.0.0.1`. Containers reach the host via `host.docker.internal`.

## Start / stop

```bash
cp observability/env.example observability/.env        # once; fill in passwords (no empty values)

npm run obs:up      # docker compose ... up -d
npm run obs:down    # docker compose ... down (keeps data volumes)

# Both scripts pass --env-file: depending on the Compose version, the implicit .env is read
# from the current directory, which from the repo root is the APP's .env.
# For other compose commands use the same flags, e.g. via an alias:
alias obs='docker compose -f observability/compose.yml --env-file observability/.env'

obs ps
obs logs -f postgres-exporter redis-exporter
```

Check required variables are set without printing them:
`grep -cE '^(GRAFANA_ADMIN_PASSWORD|PG_EXPORTER_PASSWORD|PG_EXPORTER_DATABASE)=.' observability/.env` → `3`.

PostgreSQL monitoring role (once, least privilege):

```sql
CREATE ROLE movies_monitor LOGIN PASSWORD '...';
GRANT pg_monitor TO movies_monitor;
```

After editing rules: `curl -X POST http://localhost:9090/-/reload`.

## Verification

```bash
# Config and rule syntax
docker run --rm -v "$PWD/observability/prometheus:/p:ro" --entrypoint promtool \
  prom/prometheus:v3.4.0 check config /p/prometheus.yml
docker run --rm -v "$PWD/observability/prometheus:/p:ro" --entrypoint promtool \
  prom/prometheus:v3.4.0 check rules /p/rules/movies.rules.yml

# Rule unit tests (synthetic series, no running stack needed)
docker run --rm -v "$PWD/observability/prometheus:/p:ro" --entrypoint promtool \
  prom/prometheus:v3.4.0 test rules /p/tests/movies.rules.test.yml /p/tests/slo.rules.test.yml

# Or with a local promtool (Homebrew), from observability/prometheus:
#   promtool check rules rules/*.rules.yml && promtool test rules tests/*.test.yml

# Alertmanager config
docker run --rm -v "$PWD/observability/alertmanager:/a:ro" --entrypoint amtool \
  prom/alertmanager:v0.28.1 check-config /a/alertmanager.yml
```

`check config` reports the `/etc/prometheus/rules/*.rules.yml` glob relative to the container layout; if it complains about rule files, run `check rules` separately (above).

Live checks: Prometheus → Status → Targets: all `UP`. Then the drills below.

### Alert drills (prove each alert fires and resolves)

| Drill | Expected |
|---|---|
| Stop the app (Ctrl+C on `npm run dev`) | `MoviesApiDown` pending → firing after ~1m; resolves after restart |
| Stop Redis (`brew services stop redis`), call `GET /v1/movies` a few times per minute | `RedisDown` (warning), `CacheErrors` (warning); `/readyz` stays 200 with `redis: "down"` |
| Stop PostgreSQL | `PostgresDown` (critical); `/readyz` → 503 |
| Stop Redis, then `PATCH` a movie | outbox retries → `OutboxBacklogTooOld` after the oldest event passes 120s |

Record outcomes (time to fire, time to resolve, surprises) at the bottom of this file.

## Known limitations

- Single Prometheus, local volume, 7d retention; no remote storage, no HA.
- Alertmanager has only a `null` receiver: alerts are visible in its UI, nothing is sent.
- `/v1/metrics` is unauthenticated and on the same port as the API.
- Thresholds (5% errors, 500 ms p99, 120 s outbox age) are guesses until P2 load tests.
- Node.js default metrics carry a double prefix (`nodejs_nodejs_*`) because the app registers them with `prefix: "nodejs_"`. Renaming would change metric names; left as is.
- Outbox counters are per process and reset on restart; alerts use `increase()`/`rate()`.
- SLOs are defined over 30d, but retention is 7d: burn-rate alerts work (longest window 3d),
  "remaining 30d budget" cannot be computed. The slow-burn alert needs 3d of data after a
  fresh Prometheus volume to be meaningful.
- SLO targets (99.5% availability, 99% ≤ 250 ms) and traffic guards (0.1 / 0.01 req/s) are
  guesses until P2. `HighErrorRatio`/`HighLatencyP99` overlap with the SLO alerts; kept for
  comparison, decide after drills.

## Label cardinality review (2026-11-17)

Goal: no IDs, raw URLs or unbounded user input as label values.

| Metric(s) | Labels | Values | Bounded |
|---|---|---|---|
| all app metrics | `service` | constant `movies-api` | yes |
| `cache_requests_total` | `cache`, `result` | code enums (`hit/miss/error`) | yes |
| `outbox_events_total` | `result` | code enum | yes |
| `pg_pool_connections` | `pool`, `state` | `write/read` × `total/idle/waiting` | yes |
| `http_requests_total`, `http_request_duration_seconds` | `method`, `route`, `status_code` | route **template** (`/v1/movies/:id`), else `unmatched` | yes, see below |
| `redis_exporter` | per-db, per-command | no `check-keys` configured → no per-key series | yes |
| `postgres_exporter` | `datname`, `state`, … | `application_name` is client-set (today only `movies-*`) | yes in practice; to confirm live |

Findings:
- **Fixed:** `route` used `req.baseUrl` as sent by the client. Express routing is
  case-insensitive, so `GET /V1/movies` was served but labelled `route="/V1/movies"` —
  invisible to the SLO rules, `HighLatencyP99` and dashboard panels that filter on
  `route="/v1/movies"`. Reproduced with the project's Express 5.3.0 (no network);
  fix: `req.baseUrl.toLowerCase()` (all mount paths are lower-case, no params).
  Regression tests in `src/routes/movies.test.ts` ("HTTP metrics route label"), passed (owner).
- **Accepted:** `route="unmatched"` keeps any HTTP method the Node parser accepts (fixed list
  of a few dozen) × 404/400/413 → worst case estimated at ~1–2k histogram series (estimate,
  not measured). Collapse `method` to `other` for unmatched routes if it ever matters.
- Double slashes (`/v1//movies`) and unknown sub-paths (`/v1/movies/123` for GET) → `unmatched`.

Live check (owner, 2026-11-17, app restarted with the fix):
- **Total: 2437 head series** (prometheus 848, postgres 858, redis 511, movies-api 139 live /
  188 in head incl. series of the previous process). Nothing near a cardinality problem.
- Largest metrics are Prometheus' own and exporter histograms (≤ 105 series each);
  app `http_request_duration_seconds_bucket` = 22 live (2 route/method combos × 11 buckets).
- `count by (route, method) (http_requests_total)`: only `GET /v1/movies` and `GET /readyz`
  (no PATCH since restart); no IDs, no `/V1`.
- **Finding (accepted, not fixed):** `pg_stat_activity_count` / `pg_stat_activity_max_tx_duration`
  carry the client-set `application_name`. pgAdmin sets values with IDs
  (`pgAdmin 4 - CONN:1348384`), so each new pgAdmin connection creates new series (churn),
  and these labels also list every database in the cluster, not only the app's.
  Locally negligible (34 series). Production fix belongs at the source: a policy that
  `application_name` is a fixed service name (the app already uses `movies-api:primary`).
  Relabelling it away in Prometheus would collide series (duplicate samples), so it is not
  done here. Whether a postgres_exporter flag can drop the label is unchecked.

Queries used:
```promql
topk(15, count by (__name__) ({__name__=~".+"}))
count by (job) ({__name__=~".+"})
count by (route, method) (http_requests_total)
group by (application_name, usename) (pg_stat_activity_count)
```
plus Status → TSDB Status ("Top 10 label names with high value count").

## SLOs and burn-rate alerts

Rules: `observability/prometheus/rules/slo.rules.yml` (table of SLOs, windows and burn rates
in the header). Both SLOs cover `GET /v1/movies` only.

| SLO | Good event | Target (30d) | Error budget |
|---|---|---|---|
| `movies_list_availability` | response is not 5xx (4xx count as good) | 99.5% | 0.5% |
| `movies_list_latency` | request ≤ 250 ms (`le="0.25"` bucket) | 99% | 1% |

- **Burn rate** = observed error ratio / error budget. 1× spends exactly the 30d budget in
  30d; 14.4× spends 2% of it in 1h.
- **Two windows per alert:** the long window proves the burn is significant, the short one
  makes the alert resolve soon after the burn stops. `Fast` (critical) = 14.4× over 1h+5m
  **or** 6× over 6h+30m; `Slow` (warning) = 1× over 3d+6h.
- **Why 250 ms:** a ratio "requests under X" is exact only when X is a histogram bucket
  boundary (buckets: …, 0.1, 0.25, 0.5, …). Changing the threshold means changing buckets.
- **Traffic guards:** without them one failed request out of two is a 50% error ratio ≈ 100×
  burn. Below the guard the SLO alerts are silent; `MoviesApiDown` still covers a dead app.
- Recording rules `slo:movies_list_{availability,latency}_errors:ratio_rate{5m,30m,1h,6h,3d}`
  and `slo:movies_list_requests:rate{1h,6h,3d}` can be graphed directly in Prometheus.

---

## Runbooks

Each: what it means → first checks → likely causes.

### MoviesApiDown

Prometheus cannot scrape `host.docker.internal:3000/v1/metrics`.
1. Is the app running? `curl -i localhost:3000/healthz`.
2. Prometheus → Status → Targets: error text (connection refused vs timeout vs 404).
3. If the app is up but the target is down: Docker → host networking (`host.docker.internal`), port changed (`PORT`).

### MoviesListAvailabilityBudgetBurn

`…Fast` (critical) / `…Slow` (warning): 5xx on `GET /v1/movies` are spending the 0.5% error
budget too fast. Fast = page now; Slow = a ticket, the budget will run out before 30d.
1. Prometheus: `slo:movies_list_availability_errors:ratio_rate5m` vs `…_rate1h` — still
   burning or already over (Fast stays firing up to 30m after recovery via the 6h/30m pair)?
2. Same checks as [HighErrorRatio](#higherrorratio): logs by `status_code >= 500`, `/readyz`.
3. Slow only: look for a steady low error rate (e.g. timeouts on a slow query) rather than an
   outage; compare `ratio_rate3d` with `ratio_rate6h`.

### MoviesListLatencyBudgetBurn

`…Fast` / `…Slow`: more than 1% of `GET /v1/movies` requests take over 250 ms.
1. Dashboard "GET /v1/movies latency" + "Cache hit ratio": a cache outage adds a PostgreSQL
   round trip and up to the 1 s Redis command timeout per request.
2. `pg_pool_connections{state="waiting"}`, event loop lag, PostgreSQL server connections.
3. Same checks as [HighLatencyP99](#highlatencyp99).

### HighErrorRatio

More than 5% of requests return 5xx for 5 minutes (with > 0.1 req/s).
1. Dashboard "Requests / s by route" + "5xx error ratio": which route?
2. App logs: `level >= 50` (error) around the start time; `requestId` from a failing response's `x-request-id`.
3. Check `PostgresDown`, `PgPoolWaiting` — most 5xx here come from PostgreSQL (statement timeout 2s, pool exhaustion).

### HighLatencyP99

p99 of `GET /v1/movies` above 500 ms for 10 minutes.
1. Cache hit ratio dropped? (version bump → all list keys cold; Redis down → every request pays up to the 1s Redis command timeout before falling back).
2. `PgPoolWaiting`, server connections, slow queries (`pg_stat_activity`, `EXPLAIN (ANALYZE, BUFFERS)`).
3. Event loop lag panel: CPU-bound work in the process.

### CacheErrors

Redis lookups fail; responses are served from PostgreSQL (degraded, not down).
1. `RedisDown` firing? `redis-cli ping`.
2. App logs: `component=redis` errors (reconnect loop).
3. Expect higher latency and PostgreSQL load until Redis is back.

### PgPoolWaiting

Requests wait for a pool connection (`pg_pool_connections{state="waiting"} > 0`).
1. Which pool (`write`/`read`)? Total = `PG_POOL_MAX`?
2. Long-running queries holding connections: `SELECT pid, state, now()-query_start, query FROM pg_stat_activity WHERE application_name LIKE 'movies-api%'`.
3. Load spike vs leak (connections not released). Pool size changes need P2 numbers; see the PgBouncer note in roadmap P3.

### OutboxBacklogTooOld

Oldest pending cache-invalidation event is older than 2 minutes → list cache may be stale.
1. Is the worker running (it runs inside the API process)? `MoviesApiDown`?
2. Outbox panel: `retry_scheduled` rising → handler failing (usually Redis). `RedisDown`?
3. SQL: `SELECT id, event_type, attempts, available_at, locked_by, locked_until, last_error FROM cache_invalidation_outbox WHERE processed_at IS NULL AND dead_lettered_at IS NULL ORDER BY id LIMIT 20;`

### OutboxBacklogStale

Backlog gauges have not been refreshed for over a minute, so `OutboxBacklogTooOld` is blind.
1. App logs: `Outbox backlog metrics refresh failed`.
2. PostgreSQL reachable? Worker loop alive (process up but loop stuck)?

### OutboxDeadLetters

An event reached 20 attempts and will not be retried; that invalidation is lost.
1. `SELECT id, event_type, attempts, last_error, dead_lettered_at FROM cache_invalidation_outbox WHERE dead_lettered_at IS NOT NULL ORDER BY dead_lettered_at DESC LIMIT 20;`
2. Fix the cause (`last_error`), then decide: re-queue (`UPDATE … SET dead_lettered_at = NULL, attempts = 0, available_at = now()` — safe because the handler is idempotent) or bump the list version manually.

### PostgresDown

`postgres_exporter` cannot connect (`pg_up == 0`).
1. Is PostgreSQL running? `pg_isready`.
2. If PostgreSQL is fine (`/readyz` shows `postgres_*=up`): it's the exporter. Read
   `obs logs --tail=30 postgres-exporter`: `database "…" does not exist` → wrong
   `PG_EXPORTER_DATABASE`; `password authentication failed` → password/role;
   `no pg_hba.conf entry` → allow the Docker host address. After editing
   `observability/.env`, recreate: `obs up -d postgres-exporter`.
3. App impact: `/readyz` → 503, writes fail.

### RedisDown

`redis_exporter` cannot connect (`redis_up == 0`). Warning only: cache with PostgreSQL fallback.
1. `redis-cli ping`.
2. If Redis is fine: Redis bound only to `127.0.0.1` / protected mode may reject connections from Docker; exporter credentials.
3. Watch `HighLatencyP99` and PostgreSQL load meanwhile.

### ExporterDown

Prometheus cannot scrape an exporter container; `pg_up`/`redis_up` disappear instead of turning 0.
1. `obs ps` and `obs logs <service>` (alias from "Start / stop").

### WorkerDown

`up{job="movies-worker"} == 0`: the worker process is gone (its metrics server starts first and closes last). Broker messages are not relayed and review jobs are not processed; the API keeps accepting reviews (rows pile up in `message_outbox`).
1. Is `npm run worker` running? Its last log lines: `Worker failed to start` (exit 1: PG, broker after ~15 s, or `EADDRINUSE` on `WORKER_METRICS_PORT`).
2. Started without `npm run worker`? Then `SERVICE_NAME` is not `movies-worker` (startup warning) — the target is still scraped, only labels differ.
3. After restart: `MessageOutboxBacklogTooOld` resolves as the relay catches up.

### RabbitMqDown

Prometheus cannot scrape the broker (`rabbitmq` or `rabbitmq-detailed` job). `ReviewConsumersMissing` stays silent meanwhile (by design).
1. `brew services list | grep rabbitmq`; `rabbitmq-diagnostics ping`.
2. Broker up but scrape fails: `rabbitmq-plugins list | grep prometheus` (plugin must be enabled), `curl -s localhost:15692/metrics | head -3`.
3. Impact: relay retries with backoff (outbox keeps the messages); consumer reconnects via amqplib recovery.

### ReviewConsumersMissing

`reviews.generate` has no consumer (or the queue is gone) while the broker is scraped. Review jobs stay `queued`.
1. `WorkerDown`? Then fix that first.
2. Worker up: logs `Review consumer failed to start; retrying` every 5 s → usually `PRECONDITION_FAILED` (406): a queue was declared with other arguments. Changing arguments needs the queue deleted first (`docs/progress/messaging.md` → P5.4, `topology.ts` header) — check for messages before deleting.
3. Queue gone (deleted by hand): the consumer's reopen re-declares it; if the alert persists, restart the worker.

### ReviewDeadLetterQueueNotEmpty

`reviews.generate.dlq` holds messages. Nothing consumes it: the alert stays until an operator acts.
1. Inspect (management UI → Queues → `reviews.generate.dlq` → Get messages, ack mode "Nack message requeue true"): `x-death[0].reason` = `rejected` (handler: invalid message, permanent error, attempts exhausted) or `delivery_limit` (repeated crashes before ack).
2. Per `jobId`: `SELECT id, status, attempts, last_error FROM review_jobs WHERE id = '<jobId>';` — `failed`/`succeeded`/`superseded` = nothing to do; `queued`/`running` = stuck (review finding 1) → manual recovery SQL in `docs/progress/messaging.md` → P5.4 → Failure modes.
3. Purge the DLQ once every message is accounted for (`rabbitmqctl purge_queue reviews.generate.dlq`).

### ReviewQueueBacklog

More than 50 ready messages in `reviews.generate` for 10 minutes: consumers slower than producers (threshold is a guess).
1. `review_deliveries_total` by outcome: mostly `lease_busy`/`retry_scheduled` → generator failing or slow (`review_generation_duration_seconds`); mostly `succeeded` → capacity (prefetch 4 per worker; more workers).
2. Consumers present? (`ReviewConsumersMissing`).

### MessageOutboxBacklogTooOld

Oldest unpublished `message_outbox` row is older than 2 minutes: the relay can't publish.
1. `RabbitMqDown` / `WorkerDown`?
2. `message_outbox_publish_total{result="returned"}` rising → no queue bound for the routing key (consumer topology not declared; `ReviewConsumersMissing`?).
3. SQL: `SELECT id, routing_key, attempts, available_at, last_error FROM message_outbox WHERE published_at IS NULL AND dead_lettered_at IS NULL ORDER BY available_at LIMIT 20;`

### MessageOutboxBacklogStale

The worker hasn't refreshed the `message_outbox` gauges for over a minute, so `MessageOutboxBacklogTooOld` and `MessageOutboxDeadLetters` are blind.
1. Worker logs: `Message outbox backlog metrics refresh failed` → PostgreSQL.
2. No such log: the relay loop is stuck (a batch waiting on something without its deadline).

### MessageOutboxDeadLetters

The relay gave up on rows after 20 attempts (state from PostgreSQL; survives restarts). For `review.requested` the job stays `queued` forever (review finding 1).
1. `SELECT id, routing_key, attempts, last_error, dead_lettered_at FROM message_outbox WHERE dead_lettered_at IS NOT NULL AND published_at IS NULL ORDER BY dead_lettered_at DESC LIMIT 20;`
2. Fix the cause (`last_error`, usually `unroutable`), then re-queue (SQL in `docs/progress/messaging.md` → P5.4 → Verification; safe: the consumer is idempotent).

---

## Drill log

_(date · drill · fired after · resolved after · notes)_

- 2026-11-17 · Redis stopped (`brew services stop redis`, GET every 10s, ~7 min) ·
  `RedisDown` pending 15:28:17 → firing after 62s → resolved 20s after Redis was back;
  `CacheErrors` firing after 300s (`for: 5m`), resolves only after the 5m `rate()` window
  drains (~5 min after recovery) · `/readyz` stayed 200 with `redis=down` the whole time;
  no `HighErrorRatio`/`MoviesApiDown` → readiness design confirmed (Redis never fails it).
  End-to-end detection: Redis down ~15:28:04 → firing 15:29:19 (~75s = scrape 15s +
  eval 15s + `for: 1m`).
- 2026-11-17 · finding, not a drill · `PostgresDown` firing since 14:21:17 while `/readyz`
  showed both PG pools up → `pg_up == 0` means the **exporter** cannot connect (auth/DB
  name/pg_hba), not that PostgreSQL is down. Exporter log: `pq: database "movies" does not
  exist` — `PG_EXPORTER_DATABASE` defaulted to a guessed name in `env.example`. Network,
  pg_hba and the `movies_monitor` password were fine ("Established new database
  connection"). Fix: use the app's `PG_DATABASE`; template no longer has a default.
  After recreating the exporter: `PostgresDown` firing → resolved at 15:40:34.
  Lesson: `pg_up == 0` covers both "PostgreSQL down" and "exporter misconfigured"; always
  cross-check with `/readyz` and exporter logs (runbook step 2).
- 2026-11-17 · dashboard validation, not a drill · `scripts/load-test.ts` (GET, one URL) +
  5 PATCHes 10s apart · owner: all panels showed data and matched the expected behaviour
  (5xx = 0, cache mostly `hit` with `miss` after each PATCH, outbox `processed`, pool
  `waiting` = 0, all targets up). Follow-up (static review, not yet re-checked in Grafana):
  "Redis memory / evictions" had no evictions query → added
  `rate(redis_evicted_keys_total)` on the right axis; outbox events panel switched from
  `rate()` (rare events looked like ~0) to `increase()` per non-overlapping 1m interval,
  bars, legend total.
- 2026-11-19 · App stopped (Ctrl+C on `npm run dev`, graceful) · `/readyz` unreachable
  first seen 16:50:37 (watcher polls every 5s, so the stop was 16:50:32–37) →
  `MoviesApiDown` pending 16:50:46 → firing 16:51:47 (62s pending, ~70–75s end to end =
  failed scrape + eval + `for: 1m`) · app restarted, `/readyz` 200 at 16:55:09 → resolved
  16:55:19 (~10s, one scrape + eval) · no other alert seen in the watcher while the target
  was down (app-metric alerts have no series → empty result). Not checked: Targets error
  text, absence of false alerts 5–15 min after restart (counter reset), variants 1b
  (shutdown delay window) and 1c (`kill -STOP`, hung process).
- 2026-11-19 · finding, not a drill · **PostgreSQL restart crashed the app.**
  `brew services stop` → `Unhandled 'error' event … terminating connection due to
  unexpected postmaster exit` → process exit. Cause: no `error` listener on the pg pools;
  node-postgres emits `error` on the pool when an idle client loses its connection, and an
  unhandled EventEmitter `error` throws. Impact: any PG restart/failover kills every app
  instance instead of making it not-ready (in K8s: restart loop instead of 503 from
  `/readyz`). Fix: `handleIdleClientErrors()` in `src/infrastructure/postgres.ts` logs
  pool/code/message only (pg-pool attaches `err.client`, which holds the password, and
  pino's err serializer would log it) + regression test `postgres.test.ts` (mutation-checked).
  Live re-check (owner): `pg_terminate_backend` on `application_name = 'movies-api:primary'`
  → two log lines (`pool=write` and `pool=read`, `code=57P01`), no credentials, process kept
  serving requests, `/readyz` → `ready` with both PG pools `up` (new connections opened). Side finding: the read pool also connects as `movies-api:primary` →
  `PG_REPLICA_*` is not set, the app does not use the local replica.
  Also: `brew services stop` ended with "unexpected postmaster exit" → not a clean fast
  shutdown (hypothesis: launchd SIGTERM = smart shutdown, then SIGKILL); decide how to stop
  PG before the `PostgresDown` drill.
