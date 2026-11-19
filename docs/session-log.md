# Session log

Newest first. Facts only; "owner" = verified by the repository owner outside the assistant
sandbox. Plans live in `docs/learning-roadmap.md`; per-topic details in `docs/progress/`.

---

## 2026-11-19 (session 2) · Block C: movies CRUD + optimistic concurrency

Branch `p3-movies-crud`: `a46140a` … `0a92c75`, merged into `master` (not pushed).

### Worked on / completed
- Order agreed with the owner: C → D (RAG endpoint + sync review) → B (P2) → P5 RabbitMQ.
  RabbitMQ deliberately needs a "manufactured" use case: async AI review generation.
- C1 `DELETE /v1/movies/:id` → 204. C2 `POST /v1/movies` → 201 + Location (durationMinutes was
  missing from the old schema). C3 `GET /v1/movies/:id` (primary). C4 status/version NOT NULL
  (expand/contract). C5 ETag / If-Match → 412.
- One date format: RFC 3339 UTC, microseconds, formatted in SQL (responses = cursor).

### Key decisions (why)
- GET by id reads the primary: POST → Location → GET and GET → ETag → PATCH are
  read-after-write; a replica would give false 404/412 (CLAUDE.md rule).
- Compare-and-set inside the UPDATE (`version = ANY($3)`): READ COMMITTED re-checks the
  predicate after the row lock (EvalPlanQual); read-compare-write in JS would race.
- `If-Match` optional for now (backward compatible); 404 instead of RFC's 412 for a missing id.
- `singleTransaction: false`: with the library default, the expand lock would be held during
  the contract scan. SET NOT NULL and DROP CONSTRAINT in separate statements (DROP runs first
  within one ALTER TABLE).
- Express default weak ETag on JSON bodies kept (list keeps 304); harmless for If-Match.

### Verification
- Assistant: `npx tsc -p .` exit 0; unit tests 142/142 (incl. `etag.test.ts`, 15).
- Owner: `movies.test.ts` 50/50; `npm run test:integration` 36/36; migrations on nebula (1M):
  DEBUG1 "existing constraints … sufficient to prove …" on PG 18, 0 NULL rows.
- Not run: mutation check of the If-Match predicate (suggested, optional).

### Known issues / findings
- `guard-files.sh` blocks edits to new, uncommitted migrations (owner deleted + recreated);
  could be narrowed to `git ls-files migrations/`.
- Assistant twice predicted wrong test counts (miscounted the baseline).
- `MovieRow` type is inaccurate (`release_year: string`); untouched.

### Next steps (in order)
1. `git push` (owner); delete merged branch `p3-movies-crud` (and old merged
   `p0-health-config`, `p1-observability`).
2. D: P7 — RAG HTTP endpoint + synchronous `POST /v1/movies/:id/review`; plan first
   (Gemini is billable → approval for live runs).
3. B: P2 k6 baseline (k6 install → approval). 4. P5 RabbitMQ.
5. Deferred: P1 drills 2–3, replica decision + lag alert.

---

## 2026-11-19 · Drill 1, PG pool crash fix, 1M seed, keyset EXPLAIN

Commits `fc746c4` … `6035565` on `master` (`fc746c4`, `750150b` pushed by the owner; the rest local until `git push`).

### Gap from the previous log
- 2026-11-17, after session 2 (not logged then): Grafana dashboard validated under load
  (`3145a20`), SLOs + burn-rate alerts for `GET /v1/movies` (`51c4b4b`), label-cardinality
  review + `route` casing fix (`574158e`, `8955c2f`), `promtool check config` /
  `amtool check-config` (`2f5a466`). Details: roadmap P1 → Status.

### Worked on / completed
- `npm run obs:up` / `obs:down` (compose with `--env-file observability/.env`); "Start / stop" docs.
- **Drill 1 (app stopped):** `MoviesApiDown` firing ~70–75 s after stop, resolved ~10 s
  after restart, no other alerts.
- **Bug found and fixed:** `brew services stop` of PostgreSQL crashed the app (no `error`
  listener on the pg pools → unhandled EventEmitter `error`). Fix + regression test
  (mutation-checked); live re-check with `pg_terminate_backend`: process stays up, `/readyz` ready.
- **Seed:** `scripts/seed-movies.sql`, 1M rows in the app DB (`nebula`) in 11.7 s.
- **P0 step 9 done:** keyset page 2 = `Index Cond` on the row comparison, no `Sort`, 5 buffers,
  0.11 ms; `OFFSET 500000` = ~38k buffers, 169 ms. `docs/progress/postgres.md`.
- Restored `observability/env.example` (deleted by mistake); committed the owner's roadmap /
  `.gitignore` edits; CLAUDE.md "Current state" + seed line.

### Key decisions (why)
- Pool error log has `pool`/`code`/`message` only: pg-pool sets `err.client`, and pino's err
  serializer would log the Client with its password.
- Bug reproduced with `pg_terminate_backend` on `application_name = 'movies-api:primary'`
  instead of stopping the server: exact, instant, doesn't touch the replica.
- Seed: deterministic md5 ids (idempotent, exact rollback), inserted in `created_at` order
  (realistic `correlation`), `created_at` ties, cache invalidated via an outbox row,
  `VACUUM (ANALYZE)` at the end. psql only (pgAdmin wraps scripts in a transaction).

### Files
- Created: `src/infrastructure/postgres.test.ts`, `scripts/seed-movies.sql`, `docs/progress/postgres.md`.
- Modified: `src/infrastructure/postgres.ts`, `package.json` (scripts `obs:up`, `obs:down`),
  `docs/progress/observability.md`, `docs/learning-roadmap.md`, `CLAUDE.md`, `.gitignore`
  (owner's edit), `docs/session-log.md`. Restored: `observability/env.example`.

### Verification
- Assistant: `npx tsc -p .` exit 0; unit tests 127/127; two mutation checks on the pool fix.
- Owner: drill 1; live pool re-check; seed on `movies_test` (10k) and `nebula` (1M); both
  EXPLAINs cold and warm.
- **Not run:** full `npm test` incl. route tests (sandbox); a throwaway PostgreSQL in the
  scratchpad to test the seed (permission denied → tested on `movies_test` instead).

### Known issues / findings
- The app does **not** use the local replica (read pool connects as `movies-api:primary`,
  `PG_REPLICA_*` unset).
- `brew services stop` ends PostgreSQL with "unexpected postmaster exit" (hypothesis: launchd
  SIGTERM = smart shutdown, then SIGKILL) → choose a stop method before drill 3.
- `movies_created_at_id_idx` ~52% full; `n_distinct(created_at)` estimate 0.74 vs actual 0.98;
  `shared_buffers` likely < working set → P3 (`docs/progress/postgres.md`).
- Drill 1 not fully checked: Targets error text, no false alerts after restart, variants 1b/1c.
- Assistant committed `24d235c` directly on `master` (didn't check the current branch).

### Next steps (in order)
1. `git push`; delete merged branches `p1-pg-pool-error-drills`, `p0-keyset-explain`.
2. Drill 2: Redis stopped + PATCH → `OutboxBacklogTooOld` (~5 min Redis down, watch the
   resolve delay caused by backoff).
3. Drill 3: PostgreSQL stopped → `PostgresDown`, `/readyz` 503, `OutboxBacklogStale` — first
   decide how to stop PG (`pg_ctl stop -m fast` vs `brew services stop`).
4. Replica: decide whether the app should read from it (`PG_REPLICA_*`, stale reads after
   PATCH); then the replica-lag alert.
5. Optional: `pg_pool_errors_total{pool}` metric. Then start P2 (k6, baseline report).

---

## 2026-11-17 (session 2) · Integration tests run

### Worked on / completed
- First run of `npm run test:integration` (owner): initially failed with `database "movies_test" does not exist` (expected — tests never create DBs); after `createdb movies_test` → **14/14 passed** (`src/routes/movies.int.test.ts` 9, `src/workers/cache-invalidation.int.test.ts` 5). Migrations applied by globalSetup.
- `npm test` (owner): all passed, incl. `src/routes/health.test.ts` (first run).
- Roadmap §4.2/§4.3/§6, P0 step 8 and CLAUDE.md "Current state" updated accordingly.

### Notes
- Previous session's next step 4 (CLAUDE.md "Current state") was already done in `d23b24a`.
- No mutation check was done to prove the integration tests can fail (owner decision).

### Next steps (in order)
1. Finish P1 drills with `node scripts/watch-alerts.ts` (app stopped; Redis stopped + PATCH; PostgreSQL stopped) → Drill log in `docs/progress/observability.md`.
2. Validate the Grafana dashboard under `scripts/load-test.ts` + PATCHes.
3. `promtool check config`, `amtool check-config`; `EXPLAIN (ANALYZE, BUFFERS)` of the second-page keyset query.
4. Start P2.

---

## 2026-11-16 – 2026-11-17 · Roadmap, P0 foundation, P1 observability

Commits `7f7bad8` … `aa53302` on `master` (pushed by the owner).

### Worked on / completed
- **Roadmap** `docs/learning-roadmap.md` (phases P0–P11, current status) + CLAUDE.md pointer.
- **P0 fixes:** `GET /v1/movies` was broken (validated `params`, controller read unset `validatedQuery`; `InvalidMoviesQueryError` mapped to 500). Code used table `movie`/BIGINT ids while the DB has `movies`/uuid → aligned code to the DB schema (DB is the source of truth).
- **Migrations:** node-pg-migrate, baseline SQL reproducing the live schema, `scripts/migrate.ts`.
- **Probes + config + logging:** `/healthz`, `/readyz`; Redis/`PORT`/`LOG_LEVEL`/`SHUTDOWN_DELAY_MS` in `env.ts`; `console.*` → pino outside RAG.
- **Integration tests** written (not run).
- **P1:** app metrics, observability compose stack, 11 alert rules + promtool tests, Grafana dashboard, runbooks, `scripts/watch-alerts.ts`, first drill.

### Key decisions (why)
- Keyset on `(created_at, id)` (matches `movies_created_at_id_idx`; uuid v4 order is meaningless); cursor carries created_at as PostgreSQL text with **microseconds** (JS `Date` loses them → skipped/duplicated rows at page edges).
- Baseline migration mirrors the DB exactly, incl. nullable `status`/`version`; tightening is a later migration. Existing DB marked applied with `--fake`. Migrations: primary only, `lock_timeout=5s`, no `statement_timeout`.
- Readiness: PostgreSQL failure → 503; **Redis never fails readiness** (cache with PG fallback; otherwise a cache outage pulls all pods). Liveness checks nothing.
- `REDIS_USERNAME`/`REDIS_PASSWORD` optional with no default (hardcoded `username: "redis"` removed).
- Outbox backlog gauges sampled by the worker every 10 s, not on scrape (scrape must not depend on DB health) + last-refresh timestamp to detect stale values.
- Labelled counters pre-created at 0 so `increase()` sees the first event (else first dead letter never alerts).
- **PgBouncer postponed** to P3 as a measured experiment (no connection pressure yet; transaction mode would silently drop `statement_timeout` passed via startup `options` and break the migration advisory lock).
- Observability stack only in compose; app/PG/Redis stay on the host; ports bound to 127.0.0.1; secrets in gitignored `observability/.env`; always `--env-file observability/.env`.
- Integration-test safety: DB name must end with `_test` (re-checked before TRUNCATE), Redis forced to db 15 (re-checked before FLUSHDB).

### Files (main)
- Created: `docs/learning-roadmap.md`, `docs/progress/observability.md`, `docs/session-log.md`, `migrations/1794853976336_baseline.sql`, `scripts/migrate.ts`, `scripts/watch-alerts.ts`, `src/infrastructure/health.ts`, `src/routes/health.ts`, `src/test/*`, `vitest.integration.config.ts`, `observability/**`, tests (`*.test.ts`, `*.int.test.ts`).
- Modified: `src/config/env.ts`, `src/app.ts`, `src/server.ts`, `src/infrastructure/{logger,postgres,redis,metrics}.ts`, `src/modules/movies/{cursor,movies.repository,movies.service}.ts`, validation files, `src/utils/validate-query.ts`, `src/workers/*`, `vitest.config.ts`, `package.json` (+ `node-pg-migrate`, scripts `migrate:*`, `test:integration`), `CLAUDE.md`.

### Verification
- Assistant: `npx tsc -p .` exit 0; unit tests 124/124 (`npx vitest run src/config src/infrastructure src/modules src/workers`); mutation checks on cursor date validation, readiness/Redis rule, cache `miss` metric (tests failed as expected, code restored).
- Owner: `src/routes/movies.test.ts` passed (2026-11-16); `migrate:up --dry-run` / `--fake` OK; up → down → up on disposable DB OK; `/healthz`, `/readyz` work; `promtool test rules` SUCCESS; all 4 scrape targets UP; Redis drill as expected (RedisDown 62 s, CacheErrors 300 s, `/readyz` 200 with `redis=down`).
- **Not run:** `npm run test:integration`; `src/routes/health.test.ts`; `promtool check config`; `amtool check-config`; `EXPLAIN (ANALYZE, BUFFERS)` of the keyset query.

### Known issues / blockers
- Assistant sandbox cannot bind/connect local ports, reach Docker, read `.env*`, or push → owner runs HTTP tests, integration tests, compose, drills, `git push`.
- Assistant committed `aa53302` directly on `master` (should have branched); owner pushed it.
- `nodejs_nodejs_*` double metric prefix (left as is to avoid renaming metrics).
- App `.env.example` contents unconfirmed for the new variables.
- `movies.version` nullable → `NULL + 1` stays NULL (P3).

### Next steps (in order)
1. `createdb movies_test && npm run test:integration` — fix any test bugs found; then `npm test` (covers `health.test.ts`).
2. Finish P1 drills with `node scripts/watch-alerts.ts` (app stopped; Redis stopped + PATCH; PostgreSQL stopped) and record them in `docs/progress/observability.md` → Drill log.
3. Validate the Grafana dashboard under `scripts/load-test.ts` + a few PATCHes; fix panels showing "No data".
4. Update `CLAUDE.md` "Current state" (observability stack, integration tests, metrics) — proposal pending.
5. Start P2 (k6 scenarios, baseline report), then revisit alert thresholds with real numbers.
