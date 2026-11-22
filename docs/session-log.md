# Session log

Newest first. Facts only; "owner" = verified by the repository owner outside the assistant
sandbox. Plans live in `docs/learning-roadmap.md`; per-topic details in `docs/progress/`.

---

## 2026-11-22 (session 2) · D5: `docs/progress/rag.md` for the HTTP layer; D6: prompt delimiters

Branch `p7-rag-docs` (from `master` at `e311a3a`): `bac6506` (D5). Branch `p7-prompt-delimiters`
(from `p7-rag-docs`): D6. Not merged, not pushed.

### D6 (owner approved: option B, `<question>` wrapper, `&lt;` replacement, new branch)
- `src/modules/rag/prompt-safety.ts`: `neutralizeDelimiters` (escapes `<` of `context`/`movie`/
  `question` tags: any case, inner whitespace, attributes, unterminated; idempotent; leaves
  `<contextual>`, `Promise<T>`) and `toSingleLine` for one-line header values.
- Answer prompt: context + question neutralized; question now in `<question>…</question>`;
  system instruction rule 9 names the tag. Review prompt: title (single line) + description
  neutralized. Context builder: `source`/`documentId` single-line.
- Deviation from the plan (stated to the owner): delimiter neutralization of chunk content is
  done where the answer prompt is built, not in `ContextBuilderService.formatChunk` — the tags
  live there, and direct callers of generation are covered too. Search `chunks` stay raw.
- Threat model in `docs/progress/rag.md` (not closed: instructions inside data, Unicode
  look-alikes, header-like lines inside chunk content; no tools → no actions possible).
- Files: created `src/modules/rag/prompt-safety{,.test}.ts`; modified
  `src/modules/rag/context/context-builder.service{,.test}.ts`,
  `src/modules/rag/generation/{gemini-generation,movie-review-generation}.service{,.test}.ts`,
  `docs/progress/rag.md`, `docs/learning-roadmap.md`, `docs/session-log.md`.
- Verification (assistant): `npx tsc -p .` exit 0; unit tests 269/269 (`src/modules src/config
  src/infrastructure src/workers src/utils`), RAG-related 197/197; 8 mutation checks all caught,
  code restored. Not run: `src/routes` tests (owner; prompt-only change, HTTP untouched),
  integration tests, live Gemini — effect on model behavior is not measured.

### Corrections to the previous entry
- `p7-rag-endpoints` **was merged into `master` and pushed** by the owner (`master` =
  `origin/master` = `e311a3a`; the branch no longer exists). The previous entry says "not merged".
- Owner: integration tests OK after the merge (count not reported).

### Worked on / completed
- D5: `docs/progress/rag.md` rewritten from the code: status, architecture incl. HTTP layer,
  decisions (config, signal/deadlines, error table, generation, metrics), per-file test counts,
  open issues (old #1, #4, #6, #9, #11 resolved; #5 extended to `</movie>`; #12–#18 new).
- Roadmap header / "next task" updated (merged; next = D6).

### Verification
- Assistant: `npx tsc -p .` exit 0; RAG-related unit tests 166/166 in 13 files.
- Test descriptions in `rag.md` checked against test names; docs only, no code changed.

### Next steps (in order)
1. Owner: `npx vitest run src/routes` on `p7-prompt-delimiters`; push + merge it (contains D5 + D6).
2. Owner: RAG vars in `.env.example`.
3. B: P2 k6 baseline (k6 install → approval). 4. P5 RabbitMQ (async review worker).
5. Deferred RAG: review status rule, rate limit / token budget, alerts for `rag_*`, injection
   eval set + random boundaries (P8).

---

## 2026-11-22 · Block D (P7): RAG config, typed errors, search/answer/review endpoints

Branch `p7-rag-endpoints` (from `master` at `3351a88`): `3a86823` (D0), `174cf89` (D1),
`612c6ff` (D2), `e8accff` (D3), `be3f67a` (docs), `9c09701` (D4) + end-of-session docs commit.
Not merged, not pushed. Working tree clean before the docs commit.

### Worked on / completed
- D0: optional RAG config `src/config/rag.ts` (`GEMINI_API_KEY`, `QDRANT_URL`, `QDRANT_API_KEY`,
  `QDRANT_TIMEOUT_MS` = 5 s); lazy `getGeminiClient()`/`getQdrantClient()`; no `loadEnvFile`.
- D1: `RagInputError`, `RagUpstreamError{stage, retryable}`; `createRequestSignal` (deadline /
  client disconnect / shutdown); `toRagHttpError` → 400/499/502/503/504; abort of in-flight work
  right before `server.close()`.
- D2: `POST /v1/knowledge-base/search` → `{ data: { chunks, retrievedChunks, includedChunks } }`.
- D3: `POST /v1/rag/answer` → `{ data: RagAnswerResult }`; metrics `rag_stage_duration_seconds`,
  `rag_generation_skipped_total`, `rag_generation_attempts_total`, `rag_tokens_total`; pino logger
  in generation.
- D4: `POST /v1/movies/:id/review` → `{ data: { movieId, movieVersion, review, model } }`
  (primary read, 404 `MOVIE_NOT_FOUND`, 30 s, not persisted); `generation/gemini-generate.ts` is the
  single `generateContent` call site (retry loop moved unchanged); `operation` label
  (`answer`/`review`; stages: `retrieval`) on RAG metrics.
- Docs: owner's uncommitted roadmap/session-log edits reviewed — block C additions kept,
  stale header/"next task" replaced; CLAUDE.md "Current state" updated (RAG config, RAG endpoints,
  no live Gemini runs).

### Key decisions (why)
- **No live Gemini runs** (owner): billable and mostly 503. Behavior is implemented as designed and
  verified with mocks only (recorded in CLAUDE.md).
- RAG config separate from `env.ts`: `env.ts` requires `PG_*` at import; RAG scripts shouldn't.
  Partial config fails fast; none → API starts, RAG routes answer 503 `RAG_NOT_CONFIGURED`.
- Abort reason decides the HTTP status, not the thrown error: Gemini SDK aborts with its own
  controller and loses our reason. First reason wins.
- Shutdown aborts in-flight work at `server.close()`, not at `markShuttingDown()`, so requests in
  the `SHUTDOWN_DELAY_MS` window are still served.
- 502 for non-retryable upstream failures (invalid response, 4xx) vs 503 for transient ones.
- RagInputError → `VALIDATION_ERROR`, same code as the Zod boundary.
- Search returns raw `chunks` (new additive `BuiltContext.chunks`), not prompt-formatted text.
- Deadlines 5 s / 30 s are hypotheses; 30 s < one 60 s generation attempt by design.
- Review (owner): same model, temperature 0.7, 1024 output tokens; movie fields inside
  `<movie>…</movie>` marked untrusted. No `generatedAt`: API dates come from SQL (microseconds),
  response time is in the `Date` header. Generation skipped if the deadline passed during the DB read.

### Files
- Created: `src/config/rag.ts`, `src/infrastructure/shutdown-signal.ts`,
  `src/utils/request-signal.ts`, `src/modules/rag/{rag.errors,rag-http-errors,rag-metrics,rag-deadlines,rag.controller}.ts`,
  `src/modules/rag/validation/{knowledge-base-search,rag-answer}.ts`,
  `src/modules/rag/generation/{gemini-generate,movie-review-generation.service}.ts`,
  `src/modules/movies/movie-review.controller.ts`, `src/routes/rag.ts`; tests
  `src/config/rag.test.ts`, `src/infrastructure/rag-clients.test.ts`, `src/utils/request-signal.test.ts`,
  `src/modules/rag/{rag.errors,rag-http-errors,rag-metrics}.test.ts`,
  `src/modules/rag/generation/movie-review-generation.service.test.ts`,
  `src/routes/{rag,movie-review}.test.ts`.
- Modified: `src/{app,server}.ts`, `src/config/env.ts` (comment), `src/infrastructure/{metrics.ts,gemini/gemini.client.ts,qdrant/qdrant.client.ts}`,
  `src/routes/movies.ts`, RAG services (embedding, generation, qdrant search/document/collection,
  knowledge-base search, rag-service, context builder + types) and their tests,
  `scripts/{create-qdrant-collection,test-qdrant,test-qdrant-search,test-qdrant-upsert}.ts`,
  `CLAUDE.md`, `docs/learning-roadmap.md`, `docs/session-log.md`.

### Verification
- Assistant: `npx tsc -p .` exit 0; unit tests 238/238 (`npx vitest run src/config src/infrastructure
  src/modules src/workers src/utils`); mutation checks (all caught, code restored): client getters,
  abort-reason precedence, `writableFinished`, wrap-after-abort, attempt/token metrics, review
  `operation` label, tokens per operation, `<movie>` block.
- Owner: `npx vitest run src/routes` passed after D2, D3 and D4 (incl. `rag.test.ts`,
  `movie-review.test.ts`, `movies.test.ts`). Exact counts not reported.
- Not run: integration tests (`npm run test:integration`) after the `app.ts`/`routes/movies.ts`
  changes; any RAG script; live Gemini/Qdrant; shutdown path in `server.ts` (typecheck only).

### Known issues / findings
- RAG scripts importing generation need `PG_*` again (logger → `env.ts`); also import
  `metrics.ts` (`collectDefaultMetrics`) — effect on script exit not checked.
- `usageMetadata` field names checked against `@google/genai@3.0.0` types only; its JSDoc says
  "not supported in Gemini API" → `rag_tokens_total` may stay 0.
- Aborted requests (499) never reach HTTP metrics (recorded on `finish`).
- `docs/progress/rag.md` is stale (says no HTTP endpoint; open issues #1, #4, #6, #9, #11 changed) → D5.
- Prompt delimiters unescaped: `</context>` (issue #5) and now `</movie>` → D6.
- Review allowed for any movie status (`draft`/`archived` too) — no requirement given; open decision.
- No rate limit / token budget on billable endpoints (`// LAB:`).
- Response casing is mixed in the API (movies snake_case, RAG/review camelCase) — pre-existing.
- `.env.example` needs the RAG variables (owner; assistant can't read `.env*`).
- Assistant sandbox: no local port binding → owner runs `src/routes` tests; zsh doesn't word-split
  unquoted `$VAR` in scripts (a mutation run silently tested nothing once; re-run with explicit paths).

### Next steps (in order)
1. D5 (docs only): rewrite `docs/progress/rag.md` — status, architecture with the HTTP layer,
   decisions (errors, signal, deadlines, metrics, review), tests, updated open issues.
2. D6: plan, then escape/neutralize prompt delimiters for `<context>` and `<movie>` with tests.
3. Owner: `npm run test:integration` on the branch; add RAG vars to `.env.example`; then push and
   merge `p7-rag-endpoints` (PR or fast-forward).
4. B: P2 k6 baseline (k6 install → approval). 5. P5 RabbitMQ (async review worker).
6. Deferred: P1 drills 2–3, replica decision + lag alert; review status rule; rate limiting.

---

## 2026-11-19 (session 2) · Block C: movies CRUD + optimistic concurrency

Branch `p3-movies-crud`: `a46140a` … `0a92c75` + docs `3351a88`, fast-forwarded into `master`;
pushed and merged branches deleted by the owner.

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

### Files
- Created: `migrations/1795116743325_movies_status_version_backfill.sql`,
  `migrations/1795116743326_movies_status_version_not_null.sql`, `src/modules/movies/etag.ts`,
  `src/modules/movies/etag.test.ts`, `src/modules/movies/validation/movie-id-params.ts`.
- Modified: `src/routes/movies.ts`, `src/modules/movies/{movies.controller,movies.repository,movies.service}.ts`,
  `src/modules/movies/validation/{create-movie,update-movie}.ts`, `src/models/movies.ts`,
  `scripts/migrate.ts`, `scripts/seed-movies.sql`, `src/test/integration-global-setup.ts`,
  tests (`src/routes/movies.test.ts`, `src/routes/movies.int.test.ts`,
  `src/workers/cache-invalidation.int.test.ts`), `CLAUDE.md`, `docs/learning-roadmap.md`,
  `docs/session-log.md`.

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
1. D (P7), plan only, no code until approved: read `docs/progress/rag.md` (open issues),
   `src/modules/rag/` entry points; propose `POST /v1/knowledge-base/search`,
   `POST /v1/rag/answer` and synchronous `POST /v1/movies/:id/review` (Zod limits, deadline +
   client-disconnect `AbortSignal`, typed errors → 400/503/504, stage metrics). Known blocker:
   Qdrant/Gemini config is outside `env.ts` (roadmap §4.2) — decide whether to move it first.
   Live Gemini runs are billable → owner approval.
2. B: P2 k6 baseline (k6 install → approval). 3. P5 RabbitMQ (async review worker).
4. Deferred: P1 drills 2–3, replica decision + lag alert; optional `If-Match` mutation check.

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
