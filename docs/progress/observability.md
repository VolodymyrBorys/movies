# Observability — progress and runbooks

_Started: 2026-11-17 · Roadmap phase P1 · Code and config are the source of truth._

## What runs where

| Component | Where | URL |
|---|---|---|
| Movies API (`npm run dev`) | host | `http://localhost:3000/v1/metrics` |
| PostgreSQL, Redis | host | — |
| Prometheus | compose | http://localhost:9090 |
| Alertmanager | compose (no external receivers) | http://localhost:9093 |
| Grafana (dashboard "Movies API") | compose | http://localhost:3001 |
| postgres_exporter, redis_exporter | compose, internal network only | scraped by Prometheus |

All ports bind to `127.0.0.1`. Containers reach the host via `host.docker.internal`.

## Start / stop

```bash
cp observability/env.example observability/.env        # once; fill in passwords (no empty values)

# Always pass --env-file: depending on the Compose version, the implicit .env is read
# from the current directory, which from the repo root is the APP's .env.
alias obs='docker compose -f observability/compose.yml --env-file observability/.env'

obs up -d
obs ps
obs logs -f postgres-exporter redis-exporter
obs down        # keeps data volumes
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
  prom/prometheus:v3.4.0 test rules /p/tests/movies.rules.test.yml

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

---

## Runbooks

Each: what it means → first checks → likely causes.

### MoviesApiDown

Prometheus cannot scrape `host.docker.internal:3000/v1/metrics`.
1. Is the app running? `curl -i localhost:3000/healthz`.
2. Prometheus → Status → Targets: error text (connection refused vs timeout vs 404).
3. If the app is up but the target is down: Docker → host networking (`host.docker.internal`), port changed (`PORT`).

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
2. If PostgreSQL is fine: exporter credentials (`observability/.env`), `pg_hba.conf` allowing the Docker host connection, role `movies_monitor` exists.
3. App impact: `/readyz` → 503, writes fail.

### RedisDown

`redis_exporter` cannot connect (`redis_up == 0`). Warning only: cache with PostgreSQL fallback.
1. `redis-cli ping`.
2. If Redis is fine: Redis bound only to `127.0.0.1` / protected mode may reject connections from Docker; exporter credentials.
3. Watch `HighLatencyP99` and PostgreSQL load meanwhile.

### ExporterDown

Prometheus cannot scrape an exporter container; `pg_up`/`redis_up` disappear instead of turning 0.
1. `obs ps` and `obs logs <service>` (alias from "Start / stop").

---

## Drill log

_(date · drill · fired after · resolved after · notes)_
