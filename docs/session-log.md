# Session log

Newest first. Facts only; "owner" = verified by the repository owner outside the assistant
sandbox. Plans live in `docs/learning-roadmap.md`; per-topic details in `docs/progress/`.

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
