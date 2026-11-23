# Learning Roadmap — Movies Production-Engineering Lab

_Created: 2026-11-16 · HEAD at writing: `19744cd` · Baseline: `npx tsc -p .` exit 0, `npm test` 70/70 passed._
_Last updated: 2026-11-23 · `master` at `63eb93c` (D0–D6 merged and pushed by the owner); P2 baseline committed on branch `p2-k6-baseline` (not merged); P5 planned · Session notes: `docs/session-log.md`._
_Code is the source of truth. Everything below "Current implementation status" is a **plan**, not a description of what exists._

**Current phase: P5 (RabbitMQ, planned 2026-11-23); P2 baseline partly done, rest deferred by the owner; P1 in progress with drills 2–3 and replica deferred by the owner; P0 done except optional items; Phase 3 "C" block done early (CRUD + optimistic concurrency, 2026-11-19).** Order decided by the owner (2026-11-19): **D** — P7 RAG endpoint + synchronous movie review → **B** — P2 k6 baseline → **P5** RabbitMQ (async review worker). **D done (P7, 2026-11-22), merged into `master` (owner, `63eb93c`):** D0 RAG config in `src/config/rag.ts` + lazy clients, D1 typed errors + request-scoped signal, D2 `POST /v1/knowledge-base/search`, D3 `POST /v1/rag/answer` + RAG stage metrics, D4 synchronous `POST /v1/movies/:id/review` + `operation` label on generation metrics, D5 `docs/progress/rag.md` for the HTTP layer, D6 neutralization of prompt delimiters (`<context>`, `<movie>`, new `<question>`) + threat model. Owner: integration tests OK after the D0–D4 merge; `src/routes` tests passed on D6. **B partly done (P2, branch `p2-k6-baseline`, committed, not merged):** k6 scenarios P2.0 smoke, P2.1 cached reads, P2.2 cold reads written in TypeScript (`load/k6/*.ts`, own `load/k6/tsconfig.json`, `@types/k6@2.3.1`), runbook in `docs/perf/baseline.md`; npm scripts `k6:typecheck`/`k6:smoke`/`k6:cached`/`k6:cold`; **P2.0 smoke passed** (owner, 2026-11-22: 0% failed, checks 100%; API must run without `--watch`); **P2.1 cached 100–1600 req/s** green, no knee (owner, 2026-11-23, k6 side only). Deferred by the owner (2026-11-23): cached 3200+, P2.2 cold, P2.3–P2.8. **Next task:** merge `p2-k6-baseline`, branch `p5-rabbitmq` from `master`, start P5.0 (plan and decisions in Phase 5 below). **No live Gemini runs** (owner, 2026-11-22): Gemini-dependent behavior is verified with mocks only.

---

## 1. Vision

This repository is a **production-engineering learning lab**, not just a Movies API. The Movies API is a deliberately small domain that gives every infrastructure component a real job: reads to cache, writes to invalidate, events to deliver, documents to search, requests to trace.

The goal is to evolve it **incrementally** into a production-like system and, at every step, understand the mechanism well enough to operate and debug it:

- every component is introduced because the system **needs** it (a concrete use case), not because it is on this list;
- every phase ends with **measured or tested evidence** (test, `EXPLAIN ANALYZE`, load test, dashboard, alert fired and resolved);
- simplifications are marked in code (`// LAB: simplified — production would also ...`) and in phase notes.

## 2. Learning objectives

| Area                 | Objective (what "learned" means here)                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Backend architecture | Design a Node.js/TS service with explicit boundaries, typed errors, idempotent handlers, bounded retries, graceful shutdown.  |
| PostgreSQL           | Read query plans, choose indexes, reason about MVCC/locks/isolation, size pools, handle replica lag, run safe migrations.     |
| Redis                | Cache patterns, invalidation, stampede protection, eviction, persistence, replication/failover, failure behavior.             |
| RabbitMQ             | Exchanges/queues, publisher confirms, acks/redelivery, prefetch, DLX, quorum queues, outbox → broker relay.                   |
| AI engineering       | Production RAG (retrieval quality, evals, cost, failure modes), tool-calling agents, MCP, agent evaluation and observability. |
| Observability        | RED/USE metrics, exporters, dashboards, alert rules you can act on, distributed tracing with context propagation.             |
| Logging              | Structured logs, centralized search, correlation by `requestId`/`traceId`, incident investigation workflow.                   |
| Performance          | Reproducible load tests, bottleneck identification, capacity planning backed by numbers.                                      |
| Kubernetes           | Deploy, probe, scale and shut down the service correctly; understand Services, networking, Gateway API, TLS.                  |
| Cloud / IaC          | AWS networking and IAM, Terraform workflows, EKS, managed vs self-hosted trade-offs, CI/CD.                                   |

## 3. Target architecture

Target state after all phases. Components marked `*` do **not** exist yet.

```
                         Internet
                            │ TLS
                 ┌──────────▼──────────┐
                 │ Envoy Gateway*      │  Gateway API: HTTPRoute, TLS, rate limit, canary
                 └──────────┬──────────┘
                            │
        ┌───────────────────▼────────────────────┐         ┌──────────────────────┐
        │ movies-api (Deployment, HPA*)          │         │ Gemini API (external)│
        │  /v1/movies   /v1/rag*  /v1/agent*     │────────▶│ embed / generate     │
        │  /v1/metrics  /healthz  /readyz        │         └──────────────────────┘
        └───┬────────────┬───────────┬───────────┘
            │            │           │
   ┌────────▼───┐  ┌─────▼────┐  ┌───▼──────┐
   │ PostgreSQL │  │ Redis    │  │ Qdrant   │
   │ primary +  │  │ cache    │  │ vectors  │
   │ replica    │  │ (+repl*) │  └──────────┘
   │ + outbox   │  └──────────┘
   └────┬───────┘
        │ outbox relay* (SKIP LOCKED, lease)
   ┌────▼────────┐      ┌─────────────────────────────────────────┐
   │ RabbitMQ*   │─────▶│ workers* (Deployment, separate process) │
   │ exchanges,  │      │  cache invalidation, document ingestion │
   │ DLX, quorum │      │  (embedding is slow/billable → queued)  │
   └─────────────┘      └─────────────────────────────────────────┘

 Observability plane:
   Prometheus + exporters (postgres, redis; rabbitmq*) → Grafana dashboards, Alertmanager rules
     (local compose in observability/, since 2026-11-17)
   OpenTelemetry SDK* → OTel Collector* → tracing backend* (Jaeger or Tempo, decided in Phase 6)
   pino JSON stdout → log shipper* (Fluent Bit or OTel Collector) → Elasticsearch* → Kibana*

 Platform plane:
   Docker images* → Kubernetes (kind/k3d locally*, EKS later*) ← Terraform* (VPC, IAM, EKS, RDS?, ElastiCache?)
   CI/CD*: typecheck, tests, image build/scan, plan/deploy
```

Design constraints for the target:

- **One API service + one worker service.** No microservice split of the domain; the lab is about infrastructure mechanisms, not service decomposition.
- **PostgreSQL stays the source of truth.** Redis is cache only; RabbitMQ is transport, not storage. The outbox remains the atomicity mechanism — RabbitMQ does not replace it.
- **Application writes logs to stdout only.** Shipping is the platform's job (12-factor).
- **Managed vs self-hosted** is a deliberate comparison in Phase 11, not a default.

## 4. Current implementation status

Originally verified by reading the code at `19744cd`; rows updated through `aa53302` (2026-11-17). "Not verified at runtime" means the conclusion comes from code reading only.

### 4.1 Implemented

| Capability                                                                                                                                                                                | Where                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Express 5 app, `helmet`, `x-powered-by` disabled, JSON body limit 1 MB, JSON 404, central `errorHandler`                                                                                  | `src/app.ts`, `src/utils/errors.ts`                                   |
| pino + pino-http, `requestId` (UUID) in logs and `x-request-id` header, header redaction                                                                                                  | `src/app.ts`, `src/infrastructure/logger.ts`                          |
| PostgreSQL write/read pool split; optional replica (falls back to primary); `statement_timeout`, connect timeout, `application_name` per role; transaction helper with rollback + release; `error` listener on both pools (idle client loss no longer crashes the process, 2026-11-19) | `src/infrastructure/postgres.ts`                                      |
| Zod fail-fast env config: PostgreSQL, Redis, `PORT`, `LOG_LEVEL`, `SHUTDOWN_DELAY_MS` (only `PG_*` required); production requires `PG_SSL=verify-full`                                   | `src/config/env.ts`                                                   |
| Keyset pagination on `(created_at, id)` over `movies` (uuid ids), microsecond-precision opaque cursor, `limit + 1` for `hasMore`                                                         | `src/modules/movies/movies.repository.ts`, `cursor.ts`                |
| SQL migrations (node-pg-migrate): baseline of `movies` + `cache_invalidation_outbox`; runner on primary with `lock_timeout`, advisory lock, `--fake`/`--dry-run`; expand/contract: status/version NOT NULL (backfill + CHECK NOT VALID → VALIDATE → SET NOT NULL without scan, DEBUG1-proven on PG 18); one transaction per migration (`singleTransaction: false`) | `migrations/`, `scripts/migrate.ts`                                   |
| Movies CRUD: `POST /v1/movies` (201 + `Location`, Zod mirrors DB constraints, `.strict()`), `GET /v1/movies/:id` (primary read: read-after-write), `PATCH`, `DELETE` (204); every mutation + outbox row in one transaction | `src/routes/movies.ts`, `src/modules/movies/`                          |
| Optimistic concurrency: strong `ETag: "<version>"`, `If-Match` → 412 (compare-and-set in one `UPDATE`), optional header, `*` = must exist; 304 on `If-None-Match` (Express) | `src/modules/movies/etag.ts`, `movies.repository.ts`                  |
| One API date format: RFC 3339 UTC with microseconds, formatted in SQL (`CREATED_AT_UTC_SQL`), shared by responses and the cursor | `movies.repository.ts`                                                |
| Probes: `/healthz` (liveness, no deps), `/readyz` (503 on shutdown or PG pool failure; Redis reported only)                                                                               | `src/routes/health.ts`, `src/infrastructure/health.ts`                |
| Redis list cache with version key `movies:list:version`, TTL 60 s + jitter, `SET NX` version init, PG fallback on cache read failure, cache write failure doesn't fail GET                | `src/modules/movies/movies.service.ts`, `src/infrastructure/redis.ts` |
| Redis client: 1 s command timeout, offline queue disabled, reconnect with exponential backoff + jitter, keepalive, ping                                                                   | `src/infrastructure/redis.ts`                                         |
| Transactional outbox: mutation + `INSERT cache_invalidation_outbox` in one transaction; best-effort immediate invalidation after commit                                                   | `movies.repository.ts`, `movies.service.ts`                           |
| Outbox worker: `FOR UPDATE SKIP LOCKED` claim, 30 s lease, owner-checked updates, backoff + jitter (cap 5 min), dead-letter after 20 attempts                                             | `src/workers/cache-invalidation.ts`, `cache-invalidation-runner.ts`   |
| Graceful shutdown: mark not-ready → `SHUTDOWN_DELAY_MS` → stop HTTP → stop worker → close PG/Redis; 15 s forced exit; `unhandledRejection` → shutdown                                   | `src/server.ts`                                                       |
| App metrics on `GET /v1/metrics`: HTTP RED, `cache_requests_total`, `pg_pool_connections`, `outbox_events_total`, `outbox_batch_duration_seconds`, outbox backlog gauges (worker-sampled, 10 s) | `src/infrastructure/metrics.ts`, `postgres.ts`, `src/workers/`        |
| Observability stack (local compose): Prometheus, Alertmanager (null receiver), Grafana dashboard, postgres/redis exporters; 11 alert rules + 4 SLO burn-rate alerts (+13 recording rules) + promtool tests; runbooks | `observability/`, `docs/progress/observability.md`                    |
| Alert drill watcher (read-only): Prometheus alert transitions + `/readyz`                                                                                                                 | `scripts/watch-alerts.ts`                                             |
| RAG pipeline (embed → Qdrant search → bounded context → Gemini generate), cancellation, retry only in generation, 70 unit tests                                                           | `src/modules/rag/`, see `docs/progress/rag.md`                        |
| RAG HTTP (2026-11-22, branch `p7-rag-endpoints`): `POST /v1/knowledge-base/search` (5 s deadline), `POST /v1/rag/answer` (30 s; empty context → fallback without Gemini), `POST /v1/movies/:id/review` (30 s; primary read, 404, not persisted); Zod `.strict()` bodies; one `AbortSignal` per request (deadline / client disconnect / shutdown); typed errors → 400/499/502/503/504; optional RAG config (503 `RAG_NOT_CONFIGURED`); stage metrics `rag_*` with `operation` (retrieval / answer / review); single `generateContent` call site with the shared retry loop. Deadlines are hypotheses | `src/routes/rag.ts`, `src/routes/movies.ts`, `src/modules/rag/rag.controller.ts`, `src/modules/movies/movie-review.controller.ts`, `src/modules/rag/generation/gemini-generate.ts`, `rag-http-errors.ts`, `src/utils/request-signal.ts`, `src/config/rag.ts` |
| Hand-written HTTP load test (concurrency, p50/p95/p99, status counts)                                                                                                                     | `scripts/load-test.ts`                                                |
| Seed: 1M synthetic movies, deterministic/idempotent/reversible (loaded into the app DB, 2026-11-19)                                                                                      | `scripts/seed-movies.sql`, `docs/progress/postgres.md`                |

### 4.2 Partially implemented / known gaps

| Gap                                                                                                      | Evidence                                                                                                                                                                                                                           | Impact                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ~~`GET /v1/movies` validation wiring / code vs DB schema mismatch~~ — **fixed 2026-11-16** (`5f555c0`)   | Query validation wired, keyset on `(created_at, id)` over `movies` (uuid ids); `PATCH` validates uuid. `src/routes/movies.test.ts` passed when run by the owner on 2026-11-16 (supertest needs local port binding — blocked in the assistant sandbox). | Real-DB check: integration tests passed (owner, 2026-11-17).                               |
| ~~Integration tests written but never run~~ — **passed 14/14 on first run (owner, 2026-11-17)**          | `npm run test:integration` (`src/**/*.int.test.ts`, `src/test/`): keyset boundaries, cache staleness, outbox atomicity, worker SKIP LOCKED/retry/dead-letter/lease, `/readyz`. Needs `createdb movies_test` (migrations applied by globalSetup) + Redis db 15. | No mutation check was done for these tests (owner decision).                               |
| ~~Probe HTTP tests not confirmed~~ — **`npm test` passed in full (owner, 2026-11-17)**, incl. `src/routes/health.test.ts` | —                                                                                                                                                                                                                                  | —                                                                                          |
| ~~`movies.status` / `movies.version` are nullable~~ — **fixed 2026-11-19** (`2ff81c0`)                  | Expand/contract migrations; backfill `NULL` → `'draft'`/`1`.                                                                                                                                                                       | —                                                                                          |
| ~~DELETE and CREATE not exposed~~ — **fixed 2026-11-19** (`a46140a`, `b330338`)                         | —                                                                                                                                                                                                                                  | —                                                                                          |
| ~~Optimistic concurrency is half-done~~ — **fixed 2026-11-19** (`0a92c75`)                               | —                                                                                                                                                                                                                                  | —                                                                                          |
| Optimistic concurrency limits                                                                            | `If-Match` optional; 404 (not RFC 412) for a missing id with `If-Match`; a direct SQL `UPDATE` without `version + 1` keeps the old ETag; `POST` not idempotent (no `Idempotency-Key`).                                            | Clients without `If-Match` can still lose updates; make it required (428) once clients migrate; trigger for version bump; idempotency with edge retries (P10). |
| ~~Config centralization (RAG only)~~ — **fixed 2026-11-22** (`3a86823`)                                  | Optional section in `src/config/rag.ts` (null when unset, fail-fast when partial), lazy clients, no `loadEnvFile`. RAG scripts run with `node --env-file-if-exists=.env`.                                                         | RAG scripts that import the logger (generation) need `PG_*` via `.env` again (`logger.ts` → `env.ts`). |
| Logging consistency (RAG only)                                                                           | Non-RAG code uses the pino logger (2026-11-16); RAG generation since 2026-11-22. `console.*` remains only in `qdrant-collection.service.ts` (scripts). Service-level logs have no `requestId` (no request context).             | Correlation needs P6.                                                                      |
| Error model                                                                                              | `AppError` exists; movies service has its own `InvalidMoviesQueryError`. RAG typed since 2026-11-22 (`RagInputError`, `RagUpstreamError{stage, retryable}`, mapped in `rag-http-errors.ts`).                                     | Movies and RAG map errors differently.                                                     |
| Metrics / alerting coverage                                                                              | App metrics, exporters, Prometheus, Grafana, 11 alert rules and SLO burn-rate alerts for `GET /v1/movies` exist (2026-11-17); RAG stage/attempt/token metrics (2026-11-22, no alerts/dashboard yet; aborted requests are not in HTTP metrics — recorded on `finish` only). Missing: replica-lag alert (a local replica exists — owner, 2026-11-17; not yet monitored), real Alertmanager receivers. Node default metrics have a double prefix (`nodejs_nodejs_*`, registered with `prefix: "nodejs_"`). | See Phase 1 → Status.                                                                      |
| `/v1/metrics` unauthenticated, same port as the API                                                      | Mounted in `src/app.ts` under `/v1`.                                                                                                                                                                                               | Fine locally (ports bound to 127.0.0.1); must be restricted before any exposure (P9/P10).  |
| App `.env.example` may lack new variables                                                                | `PORT`, `LOG_LEVEL`, `SHUTDOWN_DELAY_MS`, `REDIS_URL`, `REDIS_USERNAME`, `REDIS_PASSWORD` were proposed for it; the assistant cannot read `.env*`, so it is unconfirmed.                                                         | New clones may miss settings; owner to check.                                              |
| Worker runs inside the API process                                                                       | `startCacheInvalidationWorker()` in `server.ts`.                                                                                                                                                                                   | Cannot scale/deploy API and worker independently.                                          |
| Installed but unused                                                                                     | OpenTelemetry packages (never initialized), `piscina` (commented out), `supertest`, `autocannon`, `src/utils/retry.ts` (not imported).                                                                                             | Dependencies without a use case yet.                                                       |
| RAG                                                                                                      | HTTP endpoints exist (see 4.1); successful generation never observed (Gemini 503) and live runs are off (owner, 2026-11-22) — Gemini behavior, `usageMetadata` field names and deadlines are unverified against the real API; open issues list in `docs/progress/rag.md` (updated for D0–D4 in D5, 2026-11-22). Prompt delimiters neutralized (D6, 2026-11-22); not prevented: instructions inside data, Unicode look-alike tags (threat model in `docs/progress/rag.md`). No rate limit / token budget on billable endpoints. | Every POST to answer/review is billed. |
| Legacy modules                                                                                           | `src/modules/{ingestion,retrieval,generation}/` not imported.                                                                                                                                                                      | Keep until an explicit task decides.                                                       |

### 4.3 Missing

- ~~DB schema / migrations in the repo~~ — **added 2026-11-16**: `node-pg-migrate`, `migrations/1794853976336_baseline.sql` (`movies`, `cache_invalidation_outbox`), `scripts/migrate.ts`, `npm run migrate:{up,down,create}`. Owner ran `--dry-run`/`--fake` on the local DB and up → down → up on a disposable DB (2026-11-16): OK.
- **Local infrastructure definition for app dependencies** (PostgreSQL primary + replica, Redis, Qdrant) and a `Dockerfile`. Deferred by the owner; PG/Redis run on the host. Only the observability stack has a compose file.
- ~~Health/readiness endpoints~~ — **added 2026-11-16**: `/healthz`, `/readyz` (`src/routes/health.ts`, `src/infrastructure/health.ts`).
- ~~Integration tests~~ — **written and passed 2026-11-17** (see 4.2).
- RabbitMQ (no code, no dependency).
- ~~Prometheus server config, Grafana dashboards, alert rules, exporters~~ — **added 2026-11-17** (`observability/`); verification partly done (Phase 1 → Status).
- Distributed tracing; Elasticsearch/Kibana.
- ◐ k6 scenarios: smoke passed, cached reads run up to 1600 req/s (2026-11-23), cold written but not run (deferred); mixed/spike/soak missing.
- AI agent, tool calling, MCP, agent evals.
- Kubernetes manifests, Gateway API/Envoy, TLS.
- Terraform, AWS, CI/CD.

## 5. Phases

Order is chosen so each phase produces the **measurement tools or infrastructure the next one needs**. Each phase lists: why, prerequisites, scope, exercises, expected outcomes, verification. Any new dependency, schema change or infra file in a phase still requires explicit approval when the phase starts (see `CLAUDE.md`).

### Dependency graph

```
P0 Foundation ──┬─▶ P1 Metrics/Alerts ──┬─▶ P2 Load testing ──┬─▶ P3 PostgreSQL
                │                       │                     ├─▶ P4 Redis
                │                       │                     └─▶ P5 RabbitMQ ──▶ P6 Tracing + Logs
                │                       │
                │                       └─▶ P7 RAG in production ──▶ P8 Agents / MCP / Evals
                │                                (P6 recommended before P8)
                └─▶ P9 Containers + Kubernetes ──▶ P10 Gateway API / Envoy / TLS ──▶ P11 AWS / Terraform / EKS / CD
                       (needs P0 health endpoints, P1 metrics; P5 for worker split)
```

Tracks after P2 can interleave: **backend** (P3–P6), **AI** (P7–P8), **platform** (P9–P11). Basic CI (typecheck + tests) can be added at any time from P0.

---

### Phase 0 — Foundation and reproducibility (**mostly done**; remaining: optional compose for app deps, optional CI)

**Why.** Every later phase needs a reproducible environment, a working read path and a way to know if the process is healthy. Load-testing a 500, or writing K8s probes without health endpoints, teaches nothing.

**Prerequisites.** None.

**Scope.**

1. ✅ Fix `GET /v1/movies` validation and align code with the DB schema + HTTP-level regression tests.
2. ✅ Schema in the repo as versioned SQL migrations (`node-pg-migrate`, up + down); up → down → up verified by the owner on a disposable DB.
3. ⏸ Local infrastructure definition: PostgreSQL primary + streaming replica, Redis, Qdrant (compose file → approval). Deferred by the owner (2026-11-16); PG/Redis run on the host.
4. ✅ `GET /healthz` (liveness: process alive, no dependency checks) and `GET /readyz` (readiness: not shutting down, PostgreSQL write/read pools respond; Redis is reported but never fails readiness — cache with PG fallback). Shutdown: not-ready → `SHUTDOWN_DELAY_MS` → close.
5. ✅ Config: Redis, `PORT`, `LOG_LEVEL`, `SHUTDOWN_DELAY_MS` in `env.ts` with defaults, so only `PG_*` stay required (no sectioning needed). RAG clients are still outside `env.ts`.
6. ✅ Replace `console.*` with the project logger in non-RAG infrastructure code.
7. Optional: CI with `npx tsc -p .` + `npm test` (CI change → approval).
8. ✅ Integration tests against real PG/Redis (`npm run test:integration`): 14/14 passed (owner, 2026-11-17).
9. ✅ `EXPLAIN (ANALYZE, BUFFERS)` for the second-page keyset query on 1M seeded rows (owner, 2026-11-19): `Index Scan using movies_created_at_id_idx`, row comparison as `Index Cond`, no `Sort`, 5 buffers, 0.11 ms warm; `OFFSET 500000` for comparison: ~38k buffers, 169 ms. Details and findings: `docs/progress/postgres.md`.

**Exercises.**

- Bring the stack up from zero using only the repo; time it; write down every manual step that remained.
- Run migrations up → down → up; verify the app still starts.
- During shutdown, call `/readyz` and confirm it reports not-ready before connections close.

**Expected outcomes.** Anyone can clone, start dependencies, migrate and run the API. Read path works. Health semantics are clear (liveness ≠ readiness).

**Verification.** Integration test against real PG/Redis (`supertest`): GET pages with cursor, PATCH → outbox row created in the same transaction → worker processes it → list version changes. `tsc`, `npm test`.

---

### Phase 1 — Metrics, dashboards and alerting (**in progress — current phase**)

**Status (2026-11-17).** Details, runbooks and drill log: `docs/progress/observability.md`.

- ✅ App metrics (cache, PG pool, outbox counters/histogram/backlog gauges + refresh timestamp); labelled counters pre-created at 0 so `increase()` sees the first event; `service` label `movies-api`.
- ✅ Compose stack (`observability/`), all 4 scrape targets UP (owner, 2026-11-17).
- ✅ 11 alert rules with severity + runbook; `promtool test rules` → SUCCESS (owner, 2026-11-17).
- ✅ Drill "Redis stopped": `RedisDown` fired after 62 s, `CacheErrors` after 300 s, `/readyz` stayed 200 with `redis=down`, no false 5xx alerts.
- ✅ Finding fixed: `PostgresDown` false positive = exporter pointed at a non-existent DB (`PG_EXPORTER_DATABASE`); resolved after fix.
- ✅ Drill "app stopped" (owner, 2026-11-19): `MoviesApiDown` firing ~70–75 s after stop, resolved ~10 s after restart, no other alerts. Not checked: Targets error text, no false alerts after restart, variants 1b (shutdown-delay 503 window) / 1c (`kill -STOP`).
- ✅ Finding fixed (2026-11-19): a PostgreSQL stop **crashed the app** (no `error` listener on pg pools). Fix + regression test; re-checked live with `pg_terminate_backend`. Drill log in `docs/progress/observability.md`.
- ⏳ Drills not done yet: Redis stopped + PATCH (`OutboxBacklogTooOld`), PostgreSQL stopped (`PostgresDown` real case; first choose the stop method — `brew services stop` ended in "unexpected postmaster exit", not a clean fast shutdown), `HighErrorRatio`/`HighLatencyP99` (better with P2 load).
- ✅ Grafana dashboard validated under traffic (`scripts/load-test.ts` + PATCHes, owner, 2026-11-17); evictions query and outbox `increase()` panel added afterwards (not yet re-checked).
- ✅ `promtool check config` SUCCESS (assistant, local promtool 3.15.0; rule-file glob is a container path, rules checked separately) and `amtool check-config` SUCCESS (owner, `prom/alertmanager:v0.28.1`: global, route, 1 receiver), 2026-11-17.
- ✅ SLOs for `GET /v1/movies` (availability 99.5%, latency 99% ≤ 250 ms, 30d) with multi-window burn-rate alerts (fast 14.4×/6×, slow 1×), recording rules, traffic guards; `promtool check rules` + `test rules` SUCCESS (assistant, local promtool 3.15.0, 2026-11-17). Not yet observed firing live.
- ✅ Label-cardinality review by code (2026-11-17): all labels bounded; fixed `route` taking the client's casing from `req.baseUrl` (`/V1/movies` escaped SLO/alerts), regression tests passed (owner). Live check (owner): 2437 series total, app labels clean; client-set `application_name` in postgres_exporter (pgAdmin includes connection IDs) noted and accepted.
- ⏳ Not started: replica-lag alert. **Correction (owner, 2026-11-17): a local replica of the movies DB exists.** **The app does not use it** (2026-11-19: read pool connects as `movies-api:primary` → `PG_REPLICA_*` unset); decide first whether it should (enables stale reads after PATCH). Still to check: replication type (streaming/logical) and how to scrape lag (no exporter targets the replica yet; `pg_stat_replication` on the primary vs `pg_last_xact_replay_timestamp()` on the replica).
- ⏸ Deferred (owner, 2026-11-17), to do later:
  - **Watchdog / dead-man's switch:** an always-firing alert routed to an external heartbeat receiver, so a dead Prometheus/Alertmanager pipeline is noticed (today nothing watches the monitoring itself).
  - **Inhibition rules** in Alertmanager: e.g. `PostgresDown` suppresses derived alerts (`HighErrorRatio`, SLO burn, `OutboxBacklogStale`); `MoviesApiDown` suppresses app-metric alerts. Prove with `amtool` + a drill.

**Why Prometheus/Grafana.** Metrics are cheap, aggregatable time series — the right tool to answer "is it healthy and how fast" and to fire alerts. Without them, Phases 2–5 have no way to show cause and effect.

**Prerequisites.** P0.

**Scope.**

- Prometheus scraping `/v1/metrics`; Grafana with provisioned dashboards (as code in repo).
- Application metrics: cache hits/misses, PG pool (total/idle/waiting), outbox processed/failed/dead-lettered counters, outbox backlog and oldest-pending age (gauge — measure query cost first), worker batch duration.
- Exporters: `postgres_exporter`, `redis_exporter` (RabbitMQ in P5).
- Alert rules + Alertmanager: high 5xx ratio, p99 latency over SLO, outbox backlog growing, any dead-lettered event, PG pool waiting > 0 sustained, Redis down, replica lag.
- Fix `service` default label.

**Exercises.**

- Define an SLO (e.g. 99% of `GET /v1/movies` < 200 ms over 30 days) and write a multi-window burn-rate alert.
- Stop Redis → watch cache-miss rate, latency (note the 1 s command timeout per request), and which alert fires.
- Pause the worker → watch outbox backlog alert; resume and watch it resolve.
- Label-cardinality review: prove no IDs/raw URLs appear as labels.

**Expected outcomes.** A RED dashboard for the API, USE dashboards for PG/Redis, alert rules each with a short runbook (what it means, first 3 checks).

**Verification.** `promtool check rules` and rule unit tests (`promtool test rules`); each alert triggered manually at least once and observed resolving.

---

### Phase 2 — Load testing and performance baseline

**Why k6.** Scripted, versionable scenarios with thresholds (pass/fail in CI), ramping arrival-rate executors (open model — avoids coordinated omission of the current closed-loop script), and native Prometheus output. The existing `scripts/load-test.ts` stays as a minimal reference.

**Prerequisites.** P0 (working read path), P1 (to correlate client and server signals).

**Scope.** Scenarios: read-heavy (cached), cache-cold, mixed read/write (PATCH triggers invalidation), soak (1 h), spike. Seed script for realistic data volume — ✅ done early (2026-11-19): `scripts/seed-movies.sql`, 1M rows loaded into the app DB (`docs/progress/postgres.md`).

**Exercises.**

- Find the knee: increase arrival rate until p99 or errors break the SLO; identify which resource saturated first (event loop lag, PG pool, PG CPU, Redis).
- Compare `PG_POOL_MAX` 2 / 10 / 50 under the same load; explain the curve.
- Measure the effect of a list-version bump under load (all list keys become cold at once).

**Status (2026-11-22).** Owner decisions: open model only; no k6 → Prometheus remote write for now (summary JSON in `docs/perf/runs/` + PromQL on the server side); writes (P2.3+) only on rows the test creates and deletes, 1M seed untouched; first step P2.0–P2.2. Written in TypeScript (owner decision): `load/k6/{smoke,read-cached,read-cold}.ts`, `load/k6/lib/common.ts` (SLO thresholds on `phase:load` requests only, `dropped_iterations` = invalid run), own `load/k6/tsconfig.json` (`npm run k6:typecheck` = `tsc -p load/k6`, `@types/k6@2.3.1`), npm scripts `k6:smoke`/`k6:cached`/`k6:cold` (params after `--`), runbook + PromQL + empty result tables in `docs/perf/baseline.md`. k6 v2.4.0 installed; `k6 inspect` parses all scenarios. P2.0 smoke passed (owner, 2026-11-22, `docs/perf/runs/2026-11-22T18-07-55-311Z-smoke.json`). P2.1 cached 100–1600 req/s: all thresholds green, no knee, k6 side only (owner, 2026-11-23; table in `docs/perf/baseline.md`). Cached 3200+, P2.2 cold and P2.3–P2.8 deferred by the owner (2026-11-23) in favour of P5.

**Expected outcomes.** A baseline report (`docs/perf/baseline.md`): throughput, p50/p95/p99, saturation point, bottleneck with evidence. Capacity estimate per pod.

**Verification.** k6 thresholds; numbers repeatable within an agreed variance across 3 runs; server-side dashboards agree with client-side results.

---

### Phase 3 — PostgreSQL internals and performance

**Why.** PostgreSQL is the source of truth and the most likely bottleneck. Understanding plans, MVCC and locks is what turns "the DB is slow" into a specific fix.

**Prerequisites.** P1, P2.

**Scope / exercises.**

- `EXPLAIN (ANALYZE, BUFFERS)`: keyset vs `OFFSET` at deep pages; index-only scans; effect of `VACUUM`/visibility map.
- Findings from the 1M seed (2026-11-19, `docs/progress/postgres.md`): `movies_created_at_id_idx` ~52% full (inserts at the left edge of a `DESC` index) → compare `ASC` index / `REINDEX` / `pgstatindex`; `n_distinct(created_at)` estimated 0.74 vs actual 0.98 → `SET STATISTICS`; check `shared_buffers` vs working set.
- Outbox table health: partial index `WHERE processed_at IS NULL AND dead_lettered_at IS NULL`, dead-tuple growth under load, retention/cleanup job for processed rows, autovacuum tuning.
- ✅ (2026-11-19) Concurrency: lost update reproduced (integration test) and fixed with `If-Match`/ETag → 412; 8 concurrent writers → 1×200 + 7×412. Remaining: compare with `SELECT ... FOR UPDATE`.
- Isolation levels: demonstrate a write-skew anomaly under Read Committed vs Serializable (with retry on `40001`, bounded).
- Replica lag: pause replay (`pg_wal_replay_pause()`), PATCH, then GET → observe stale read; decide which endpoints need `strong` consistency (repository already has the parameter).
- Pool exhaustion and `statement_timeout`: observe `pg_stat_activity`, `wait_event`, lock waits.
- ◐ Online migration: add a column/index without blocking (`CREATE INDEX CONCURRENTLY`, expand/contract), compatible with the running app version. Expand/contract NOT NULL done (C4, 2026-11-19); `CREATE INDEX CONCURRENTLY` remains.
- **PgBouncer (only if P2 proves the need).** Trigger: several app instances push server connections toward `max_connections`, or `pg_pool_connections{state="waiting"}` stays > 0 (P1 metrics + `postgres_exporter`). Experiment: transaction pooling in front of the primary; measure connections, p99 and throughput before/after. Known breakages to handle first:
  - `statement_timeout` is passed as startup `options` → rejected by PgBouncer; `ignore_startup_parameters = options` would silently drop it. Move it to `ALTER ROLE … SET statement_timeout`.
  - Migrations (node-pg-migrate session advisory lock) must connect directly to PostgreSQL, bypassing PgBouncer.
  - No session state across transactions (`SET`, `LISTEN/NOTIFY`, session advisory locks); prepared statements need PgBouncer ≥ 1.21 protocol support.
  - Size `default_pool_size` against the sum of app pools; PgBouncer itself becomes a component to make highly available.

**Expected outcomes.** Written notes per experiment with plans and numbers; optimistic concurrency implemented with tests; outbox cleanup strategy.

**Verification.** Integration tests for 409 on version mismatch; before/after `EXPLAIN ANALYZE`; load test showing the effect.

---

### Phase 4 — Redis caching, replication and failure behavior

**Why.** Caching changes both latency and failure modes. The current design (versioned keys + TTL) is correct but has known costs: orphaned keys after version bump, simultaneous cold misses, 1 s timeout on every request when Redis is slow.

**Prerequisites.** P1, P2.

**Exercises.**

- Cache stampede after version bump: measure PG QPS spike; implement and compare single-flight (in-process), distributed lock, or stale-while-revalidate. Measure each.
- Memory: `maxmemory` + `allkeys-lru` vs `volatile-ttl`; measure orphaned versioned keys and evictions.
- Failure: Redis down / slow (latency injection) — confirm PG fallback, measure added latency; evaluate a circuit breaker vs shorter command timeout.
- Persistence: RDB vs AOF trade-offs for a cache (why persistence may be unnecessary here).
- Replication + Sentinel failover during a load test; client behavior on failover.
- Benchmark: `redis-benchmark` and hit-ratio vs TTL.

**Expected outcomes.** Cache hit ratio and stampede behavior documented with numbers; a chosen stampede strategy with tests.

**Verification.** Integration tests for fallback paths; load-test comparison; Redis exporter dashboards.

---

### Phase 5 — RabbitMQ messaging and workers

**Why RabbitMQ, and why not before.** Today the outbox worker polls PostgreSQL and acts in-process — fine for one consumer. A broker becomes justified when there are **multiple independent consumers** or **slow, rate-limited work**. Concrete use cases here:

1. Domain events (`movie.updated`, `movie.deleted`) fanned out to cache invalidation and future consumers.
2. **Document ingestion for RAG**: embedding is slow, billable and rate-limited → a queue with prefetch, retries and DLQ is a natural fit.
3. **Movie review generation (Gemini)**: slow, billable, rate-limited → `202` + job, prefetch as rate limit, DLX on 503, idempotent regeneration (owner decision, 2026-11-19).

**Prerequisites.** P0, P1 (P3 helpful for outbox internals).

**Scope.**

- Outbox **relay**: claims outbox rows (existing SKIP LOCKED + lease) and publishes with **publisher confirms**; marks rows only after confirm. Outbox stays — it provides atomicity with the DB write.
- Topic exchange, quorum queues, DLX with retry queues (TTL-based delays), bounded attempts.
- Consumers in a separate worker process (split from API); manual ack; idempotency via a processed-message table or naturally idempotent handlers.
- RabbitMQ exporter/metrics: queue depth, unacked, publish/ack rates, redeliveries.
- Graceful shutdown for consumers (stop consuming, finish in-flight, ack/nack, close channel).

**Exercises.**

- Kill the broker mid-publish → verify no lost events (outbox retains them).
- Crash the consumer before ack → observe redelivery; prove the handler is idempotent.
- Poison message → ends in DLQ after N attempts; alert fires.
- Prefetch 1 vs 50: throughput and fairness.
- Throughput test: messages/s vs queue type and payload size.

**Expected outcomes.** At-least-once delivery proven end to end; worker deployable separately.

**Verification.** Integration tests with a real broker; chaos exercises with recorded results; dashboards + alerts (queue depth, DLQ > 0, consumer count = 0).

**Plan and decisions (2026-11-23, not started).** Owner decisions: `amqplib` directly (installed: `amqplib@2.4.1`, ships its own types; `@types/amqplib@0.10.8` also installed — describes the 0.10 API, removal recommended); **no live Gemini** — business logic only, generator mocked in tests; synchronous review **replaced** by `202` + job; new `message_outbox` table for broker events, `cache_invalidation_outbox` untouched; dev-only fake generator (`REVIEW_GENERATOR=fake`, configurable latency / 503 share, `// LAB:`) for manual runs and exercises; relay runs in the worker process (API never connects to the broker); RabbitMQ **local via Homebrew** (not compose), optionally a 2–3 node local cluster for quorum queues.
Flow: `POST /v1/movies/:id/review` → one `PG.transaction` inserts `review_jobs` (queued, `movie_version`) + `message_outbox` (`review.requested`) → `202` + `Location: /v1/review-jobs/:id` (existing active/succeeded job for the same version is returned, no new one). Worker: relay (ConfirmChannel, mark published after confirm, SKIP LOCKED + lease) and consumer (`reviews.generate` quorum queue, prefetch, manual ack; job already done → ack; `movie.version` changed → `superseded`, no billable call; transient error → TTL retry queue with attempt header; permanent / exhausted → `failed` + DLX → DLQ). `GET /v1/review-jobs/:id` returns status and result.
Steps: P5.0 broker (brew) + Prometheus scrape (:15692) + optional `RABBITMQ_URL` config + connection with reconnect/backoff → P5.1 migration (`review_jobs`, `message_outbox`, partial unique index on `(movie_id, movie_version)` for queued/running/succeeded) → P5.2 API (202, GET job) → P5.3 relay → P5.4 consumer + topology → P5.5 metrics/alerts/dashboard → P5.6 graceful shutdown → P5.7 exercises with the fake generator → P5.8 `docs/progress/messaging.md`. Accepted failure mode: crash between Gemini and saving the result → regenerated after lease expiry (billable duplicate).

---

### Phase 6 — Distributed tracing and centralized logging

**Why OpenTelemetry.** Once a request crosses API → PG/Redis → outbox → RabbitMQ → worker (and later RAG → Qdrant → Gemini), metrics say _that_ it is slow, traces say _where_. OTel is vendor-neutral; packages are already installed but not initialized.

**Why Elasticsearch/Kibana.** Full-text and structured search over logs across all processes, correlated by `requestId`/`trace_id`. Metrics and traces are sampled/aggregated; logs carry the specific error details.

**Prerequisites.** P1 and P5 — owner decision (2026-11-17): tracing and centralized logs start only after RabbitMQ exists; phases are done in order.

**Scope.**

- OTel SDK initialized before app imports (`--import`), auto-instrumentation for http/express/pg/redis; manual spans for outbox claim, cache lookup, RAG stages.
- Context propagation through RabbitMQ message headers (manual inject/extract) — the key learning point.
- OTel Collector → tracing backend (Jaeger or Tempo; choose at phase start). Sampling strategy (head vs tail).
- `trace_id`/`span_id` in pino logs (`@opentelemetry/instrumentation-pino`, already installed).
- Log shipping: stdout → Fluent Bit or OTel Collector → Elasticsearch; index template with explicit mappings (avoid mapping explosion), ILM retention.
- Kibana: Discover saved searches, error dashboard.

**Exercises.**

- Incident drill: alert fires (P1) → Grafana → exemplar/trace → logs in Kibana by `trace_id` → root cause. Write it up as a runbook.
- Measure tracing overhead under load (P2 scenario) with sampling 100% vs 10%.
- Verify no secrets, prompts or document bodies appear in logs/spans.

**Expected outcomes.** One trace spans API → broker → worker; every log line is searchable and correlatable.

**Verification.** Automated check that a request's `x-request-id` and `trace_id` appear in logs of both API and worker; overhead numbers recorded.

---

### Phase 7 — RAG in production

**Why.** The RAG core exists and is unit-tested; what is missing is everything that makes it operable: an API, deadlines, typed errors, metrics, and a way to know if answers are good. Open issues are listed in `docs/progress/rag.md`.

**Prerequisites.** P0, P1 (P6 recommended).

**Scope.**

- ✅ (2026-11-22) `POST /v1/knowledge-base/search` and `POST /v1/rag/answer`: Zod validation (max question length), request-scoped `AbortSignal` tied to client disconnect + overall deadline + shutdown, typed errors → 400/499/502/503/504.
- ◐ Per-stage metrics (embed, search, generate latency; tokens; skipped generations; retries) — done 2026-11-22; spans in P6.
- **Retrieval evaluation**: golden set of questions → expected documents; recall@k, MRR; use it to choose `minScore` and chunking parameters.
- ✅ (2026-11-22, D6) Prompt-injection hardening of the prompt blocks (delimiter neutralization for `<context>`/`<question>`/`<movie>`, single-line headers), documented threat model. Structural only; random boundaries and an injection eval set → P8.
- Ingestion via queue (P5) with idempotent upserts (deterministic point IDs).
- Cost controls: per-request token budget, rate limiting.
- ✅ (2026-11-22, D4) Synchronous `POST /v1/movies/:id/review` (Gemini): measure latency, timeouts, 503 behavior — the evidence that motivates the async version in P5 (owner decision, 2026-11-19). Without live Gemini runs (owner, 2026-11-22) the evidence is the design (30 s deadline vs. retries/backoff, 503 mapping) plus mocked tests, not measurements.

**Exercises.** Change chunk size → re-index → re-run eval; Gemini 503 storm → behavior and alerting; cancellation under load.

**Expected outcomes.** RAG endpoints with SLOs and an eval report that justifies parameter choices.

**Verification.** Unit + HTTP tests (mocked Gemini/Qdrant), opt-in integration run against real services (billable → approval), eval score tracked over time.

---

### Phase 8 — AI agents, tool calling, MCP and evaluation

**Why.** Agents add a loop (model decides → tool runs → model continues), which multiplies latency, cost and failure modes. The goal is to learn to make that loop **bounded, observable and testable**.

**Prerequisites.** P7 (P6 strongly recommended).

**Scope.**

- Gemini function calling with typed tools: `searchKnowledgeBase` (wraps `KnowledgeBaseSearchService`, designed for this), `listMovies` (read-only). Any mutating tool requires an idempotency key and explicit confirmation.
- Bounded loop: max steps, total deadline, token budget, tool timeouts; tool errors returned to the model as structured results.
- MCP server exposing the same tools to external clients (SDK dependency → approval).
- Evaluation: task-success set, tool-selection accuracy, argument correctness, trajectory length; regression runs with recorded fixtures (no network) + periodic live runs.
- Observability: one span per step/tool call (GenAI semantic conventions), cost/latency metrics, no prompt bodies in logs.

**Exercises.** Inject a malicious instruction into a retrieved document → verify the agent doesn't follow it; tool timeout mid-loop; compare models/params on the eval set.

**Expected outcomes.** An agent whose behavior is measured, not anecdotal.

**Verification.** Offline eval suite in CI (fixtures), live eval on demand, tracing of full trajectories.

---

### Phase 9 — Containers and Kubernetes

**Why.** Kubernetes is the de facto runtime for this kind of system; it forces explicit answers on health, resources, configuration, secrets and shutdown — most of which the code already partly handles.

**Prerequisites.** P0 (health endpoints, config), P1; worker split (P5) recommended.

**Scope.**

- Multi-stage `Dockerfile`, non-root, minimal image; image scan.
- Local cluster (kind or k3d). Deployments for `api` and `worker`; Services; ConfigMap/Secret; liveness/readiness/startup probes; requests/limits; PodDisruptionBudget.
- Graceful shutdown alignment: `preStop` delay + `terminationGracePeriodSeconds` vs the app's 15 s force-exit timer.
- Stateful dependencies: StatefulSet + PVC for PostgreSQL/Redis/RabbitMQ **for learning**; compare with operators (e.g. CloudNativePG) and managed services (P11).
- HPA on CPU, then on a custom metric (RPS or queue depth) — compare.
- Migrations as a Job before rollout.

**Exercises.** Rolling update under k6 load with zero errors; kill a pod mid-request; OOMKill by low memory limit; HPA scale-out timeline vs load.

**Expected outcomes.** Zero-downtime deploy proven under load; resource numbers derived from P2.

**Verification.** Manifest validation (e.g. `kubeconform`), k6 during rollout, dashboards for pod restarts/throttling.

---

### Phase 10 — Kubernetes networking, Gateway API, Envoy Gateway, TLS

**Why.** Gateway API is the successor to Ingress with role-separated, portable routing; Envoy Gateway is a conformant implementation that exposes Envoy features (rate limits, retries, timeouts) declaratively.

**Prerequisites.** P9.

**Scope / exercises.**

- Service types, kube-proxy, DNS, NetworkPolicies (default deny, allow API → PG/Redis only).
- GatewayClass/Gateway/HTTPRoute; TLS termination with cert-manager (self-signed locally); HTTP → HTTPS redirect.
- Traffic splitting for canary (weights) under load; header-based routing.
- Edge timeouts/retries — and the danger of retrying non-idempotent `PATCH` (retry amplification); rate limiting.
- Envoy metrics in Prometheus.

**Expected outcomes.** Encrypted ingress, canary rollout procedure, documented edge vs app responsibility for timeouts/retries.

**Verification.** `curl`/k6 against TLS endpoint, canary error budget observed, NetworkPolicy deny verified.

---

### Phase 11 — AWS, Terraform, EKS and CI/CD

**Why.** Learn how the same system maps to cloud primitives and how to manage infrastructure as reviewed, reproducible code.

**Prerequisites.** P9, P10.

**Scope.**

- Terraform fundamentals: remote state (S3 + locking), modules, `plan` review, drift.
- VPC (public/private subnets, NAT — cost aware), security groups, IAM least privilege, pod-level IAM (IRSA or EKS Pod Identity).
- EKS cluster + node groups; deploy P9/P10 manifests.
- Managed vs self-hosted comparison with a written decision: RDS PostgreSQL (+ read replica) vs StatefulSet; ElastiCache vs Redis in cluster; Amazon MQ vs RabbitMQ in cluster. Criteria: operations, failover, cost, observability.
- Secrets: AWS Secrets Manager + External Secrets (or equivalent).
- CI/CD: typecheck, tests, image build/scan/push (ECR), `terraform plan` on PR, manual approval for `apply`, deploy via OIDC (no long-lived keys).
- Budget alarms; destroy procedure after each session.

**Expected outcomes.** Reproducible cloud environment from code; documented cost per hour; a managed-vs-self-hosted decision record.

**Verification.** `terraform validate`/`plan` in CI; smoke tests and k6 against the cloud endpoint; `terraform destroy` leaves nothing billable.

> Safety: every `terraform apply`, `kubectl apply` and cloud action is run by the owner, never automatically by an assistant.

---

## 6. Testing and verification strategy (cross-cutting)

| Level              | Tooling                                        | What it proves                                  | Introduced        |
| ------------------ | ---------------------------------------------- | ----------------------------------------------- | ----------------- |
| Typecheck          | `npx tsc -p .`                                 | Types/contracts compile under strict settings   | exists            |
| Unit               | Vitest, external I/O via `vi.mock`             | Logic of a single module                        | exists: RAG (incl. errors, stage metrics), cursor, config (incl. RAG), readiness, metrics, ETag, request signal, review generation, prompt delimiters (269 tests, assistant, 2026-11-22) |
| HTTP (mocked deps) | Vitest + `supertest`, PG/Redis mocked          | Routing, validation, controller → repository    | exists (`src/routes/*.test.ts`; needs local port; `movies.test.ts` 50/50, owner 2026-11-19; `rag.test.ts`, `movie-review.test.ts` passed, owner 2026-11-22) |
| Integration        | `npm run test:integration`, real PG/Redis      | SQL vs schema, transactions, outbox, cache      | exists, 36/36 passed (owner, 2026-11-19) |
| Migration          | up → down → up on a real DB                    | Rollback path exists                            | done manually (owner, 2026-11-16); expand/contract on 1M rows (nebula, owner, 2026-11-19) |
| Failure injection  | stop/pause containers, latency injection       | Fallbacks, retries, alerts behave as designed   | P1+               |
| Load               | k6 with thresholds                             | SLO under defined load; capacity                | P2: smoke/cached/cold scenarios written + typechecked (`npm run k6:typecheck`); smoke passed, cached 100–1600 req/s green (2026-11-23); cold and P2.3+ deferred |
| Query performance  | `EXPLAIN (ANALYZE, BUFFERS)` before/after      | Perf claims are measured                        | first plan recorded (keyset vs OFFSET, 1M rows, 2026-11-19); P3 |
| Messaging          | real broker, kill/crash drills                 | At-least-once, idempotency, DLQ                 | P5                |
| Observability      | `promtool test rules`, drills via `scripts/watch-alerts.ts` | Alerts fire and resolve           | P1 (rule tests pass; 2 of ~5 drills done), P6 |
| AI evals           | golden sets, fixtures, live runs               | Retrieval/agent quality over time               | P7, P8            |
| Infra              | `terraform validate/plan`, manifest validation | Infra changes reviewed before apply             | P9–P11            |

Rules: never change a test to make wrong code pass; bug fix → regression test; performance claims need numbers; "verified" means the command actually ran.

## 7. Working agreement per phase

1. Start: re-check this document's status against code; list required approvals (dependencies, schema, infra, CI).
2. Implement one mechanism at a time; mark simplifications with `// LAB:`.
3. Prove it (test, plan, load test, alert drill).
4. Finish: write `docs/progress/<topic>.md` (format as in `docs/progress/rag.md`), update section 4 here and the "Current state" in `CLAUDE.md`.
