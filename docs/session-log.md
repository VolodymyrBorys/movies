# Session checkpoint

Last session only; rewritten on each save. Previous checkpoints: `docs/sessions/archive/` (history, not read at session start).
"owner" = verified by the repository owner outside the assistant sandbox. Plan: `docs/learning-roadmap.md`, active phase: `docs/learning/current-phase.md`; per-topic details: `docs/progress/`.

## 2026-11-23 (session 3) · P5.3 outbox relay

Branch `p5-rabbitmq`: `00f90a8` (P5.3) + this docs save. Local branch is 3+ commits ahead of
`origin/p5-rabbitmq` (`8360c91`, `b3002c9`, `00f90a8`): owner pushes. Not merged.

### Completed
- **P5.3** (plan approved by the owner first): worker process `src/worker.ts` (`npm run worker`),
  `PublishChannel` (confirm channel holder), topology (`movies.events`), relay + runner, unit and
  integration tests. Details, failure modes, verification: `docs/progress/messaging.md` → P5.3.
- `backend-reviewer` review → 4 fixes (startup-signal hang, stale reopen timer, `blocked` burning
  attempts, reschedule logging on 0 rows) + 1 documented limitation (late `basic.return`).
- `CLAUDE.md` "Current state": worker process / relay sentence added (owner approved).

### Decisions (owner, 2026-11-23)
- Exchange `movies.events` (topic, durable), one for all domain events.
- Unroutable messages: `mandatory` + `basic.return` → retry (not an alternate exchange).
- Relay metrics deferred to P5.5 (worker needs its own `/metrics` port); logs carry `result` until then.
- New npm script `worker`.

### Verification
- Assistant: `npx tsc -p .` 0; unit 322/322 (`src/config src/infrastructure src/modules src/workers
  src/utils src/messaging`); 7 mutation checks, all caught (list in `messaging.md`).
- Owner: `npm run test:integration` green incl. `outbox-relay.int.test.ts` (counts not reported);
  `npm run worker` against the local broker → channel open, started; Ctrl+C → shutdown ~0.6 s.
- Not done: live publish path (no queue → `returned` + retry; temporary queue → `published`);
  Ctrl+C during startup with the broker stopped; reconnect mid-batch against a real broker;
  `src/worker.ts` startup/shutdown has no automated test.

### Known issues
- Until P5.4 binds a queue, every `review.requested` is returned and dead-letters after 20 attempts
  (~51 min) → after P5.4, re-queue those rows (reset `dead_lettered_at`, `attempts`, `available_at`).
- Worker logs: `service` is `movies-api` (shared root logger) and nested `child()` writes `component`
  twice. Fix with a worker logger in P5.5.
- `retryDelayMs` (relay and cache-invalidation worker): exponent cap 8 → effective max 256 s; the
  5 min cap is dead code. Not changed.
- Still open from earlier: Gemini-dependent RAG ingest scripts fail by design (`embedDocument` stub);
  `git push` blocked in the sandbox; stale `[branch "p2-k6-baseline"]` in `.git/config`;
  `RABBITMQ_URL=` in `.env.example` unconfirmed; remote `p2-k6-baseline` / `p7-prompt-delimiters`
  deletion unconfirmed; P5.1 up → down → up on a disposable DB not reported; mutation check of
  review `ON CONFLICT` dedupe not done.
- Low priority (2026-11-22): under `npm run dev` (`--watch`) a process with `shuttingDown=true` kept
  serving; possible `shutdown()` bug. Check: Ctrl+C under k6 load (no `--watch`) → exit ≤ 15 s.

### Update 2026-11-25 (session 4)
- Branch pushed (in sync with `origin/p5-rabbitmq`).
- P5.3 live check passed (owner): returned → retry with backoff → published after a temporary
  queue was bound; AMQP properties and outbox row correct; worker startup with the broker stopped
  (give up, late broker, Ctrl+C → `SIGINT`, exit 0). Details: `messaging.md` → P5.3 → Verification.
  Still not verified: reconnect mid-batch (P5.7).

### Next steps
1. ~~Owner: push; P5.3 live publish check~~ done 2026-11-25.
2. P5.4 plan (no code until approved): consumer in the worker process, quorum queue
   `reviews.generate` bound to `movies.events` / `review.requested`, prefetch, manual ack, TTL retry
   queues with attempt tracking (DB `attempts` authoritative), DLX → DLQ, `superseded` on version
   change, ack when the job no longer exists, fake generator (`REVIEW_GENERATOR=fake`), consumer
   setup inside `PublishChannel`-style recovery `setup`.
3. After P5.4: re-queue the dead-lettered `review.requested` rows from the P5.3 period.
