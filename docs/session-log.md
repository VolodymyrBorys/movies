# Session checkpoint

Last session only; rewritten on each save. Previous checkpoints: `docs/sessions/archive/` (history, not read at session start).
"owner" = verified by the repository owner outside the assistant sandbox. Plan: `docs/learning-roadmap.md`, active phase: `docs/learning/current-phase.md`; per-topic details: `docs/progress/`.

## 2026-11-23 (session 2) · P5.1 schema, P5.2 async review API, Gemini stubs

Branch `p5-rabbitmq`: `dd57434` (P5.1), `4cf17fb` (P5.2), `57d7b59` (stubs), owner's
`b35a557` (`src/modules/reviews/review-flow.txt`). Pushed by the owner; not merged.

### Completed
- Prometheus target `rabbitmq` UP: `rabbitmq_prometheus` was disabled (Homebrew default;
  management on :15672 is a separate plugin). Owner enabled it.
- **P5.1:** `migrations/1795432527618_review_jobs_message_outbox.sql`, SQL approved by the owner
  before writing. `review_jobs` (status CHECK, lease ⇔ running, result ⇔ succeeded,
  finished_at ⇔ terminal, partial unique `(movie_id, movie_version)` for queued/running/succeeded,
  FK `ON DELETE CASCADE` + `movie_id` index) and `message_outbox` (claim/lease/retry columns like
  `cache_invalidation_outbox` + `message_id`, `routing_key`, `payload jsonb`). The integration
  `TRUNCATE` now includes both tables (otherwise the FK breaks it).
- **P5.2:** `POST /v1/movies/:id/review` → one transaction: SELECT version → `INSERT ... ON
  CONFLICT DO NOTHING` → outbox row, or the existing job (at most 2 rounds). 202 + `Location`
  for new/active jobs, 200 for succeeded, 404 also on FK `23503`. `GET /v1/review-jobs/:id`
  (primary, camelCase, no `last_error`/lease). Sync controller deleted. Date helper
  `src/utils/sql-dates.ts` shared with movies (format unchanged).
- **Gemini stubs** (owner request): answer, review and `embedQuery` run real code up to the SDK
  call and return a static result ("message from gemini" / model "stub" / constant unit
  vector). `embedDocument` throws. On by default; `{ geminiStub: false }` in code for real calls.

### Decisions
- Owner: all 7 P5.1 schema decisions as proposed (cascade, text + CHECK, lease in the job,
  DB attempts authoritative, `routing_key`, `message_id`, relay order `(available_at, id)`);
  P5.2: 200 for succeeded, shared date helper, delete the sync controller.
- Stub as a constructor option, not a bare early `return` (keeps the real path testable) and
  not an env flag (no config value can turn on billing). `embedDocument` refuses so stub
  vectors never reach the real Qdrant collection.
- Result delivery: polling the job (`Location`). Webhook / SSE compared and deferred.

### Verification
- Assistant: `npx tsc -p .` 0; unit tests 293/293 (`src/config src/infrastructure src/modules
  src/workers src/utils`). Mutation checks (caught, restored): stub default off in review (2 failed),
  answer (1 failed), embeddings (3 failed).
- Owner: `npm run test:integration` 36/36 with the new migration on `movies_test`;
  `migrate:up --dry-run` + `migrate:up` on the app DB; after P5.2 `src/routes` and
  integration tests green (counts not reported; expected 49 integration).
- Not done: up → down → up of P5.1 on a disposable DB; mutation check of `ON CONFLICT` /
  dedupe (needs the owner's integration run); job ↔ outbox atomicity on a failed outbox
  insert; any live run of the stubs.

### Known issues
- Jobs stay `queued` until P5.3/P5.4 exist; no signal for that yet (P5.5).
- RAG scripts that ingest (`embedDocument`) now fail by design; `scripts/test-embed.ts`,
  `test-gemini-generation.ts` return the stub.
- `git push` is blocked in the sandbox (no GitHub credentials) → owner pushes.
- Stale `[branch "p2-k6-baseline"]` in `.git/config`; `RABBITMQ_URL=` in `.env.example`
  unconfirmed; remote `p2-k6-baseline` / `p7-prompt-delimiters` deletion unconfirmed.

### Next steps
1. P5.3 plan (no code until approved): worker process entry point (separate from `server.ts`),
   relay claim on `message_outbox` (SKIP LOCKED + lease, order `(available_at, id)`),
   ConfirmChannel, mark published only after confirm, retry/backoff/dead-letter, exchange
   declaration (topic exchange name), `message_id` as AMQP messageId, metrics hooks for P5.5.
2. Then P5.4 consumer + topology (quorum queue, TTL retry queues, DLX/DLQ, superseded check).

### Carried over from earlier sessions (still open)
- Low priority (2026-11-22): under `npm run dev` (`--watch`) a process with `shuttingDown=true` kept serving
  with working PG; possible `shutdown()` bug. Check: Ctrl+C under k6 load (no `--watch`) → exit ≤ 15 s.

### After this entry (2026-11-23, uncommitted, pending owner review)
- Docs restructured for smaller session-start context: roadmap → index + `docs/learning/*`; this file →
  checkpoint; full history in `docs/sessions/archive/2026-11.md`; `resume.md` / `save.md` (root) adapted.
