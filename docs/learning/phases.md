# Phase plans (inactive phases)

_Reference, not read at session start. Moved verbatim from `docs/learning-roadmap.md` §5 (2026-11-23). The active phase lives in `docs/learning/current-phase.md`; phase order and status index: `docs/learning-roadmap.md`. Phase headings keep their original wording (e.g. P1 still says "current phase" — the current phase is P5)._

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
- Outbox table health: partial index `WHERE processed_at IS NULL AND dead_lettered_at IS NULL`, dead-tuple growth under load, retention/cleanup job for processed rows (now also `message_outbox`), autovacuum tuning. Hypothesis (2026-11-23): the cache-invalidation claim orders by `id` over the `(available_at, id)` index → Sort on a large backlog; check with `EXPLAIN`.
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
