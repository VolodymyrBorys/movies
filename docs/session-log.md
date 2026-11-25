# Session checkpoint

Last session only; rewritten on each save. Previous checkpoints: `docs/sessions/archive/` (history, not read at session start).
"owner" = verified by the repository owner outside the assistant sandbox. Plan: `docs/learning-roadmap.md`, active phase: `docs/learning/current-phase.md`; per-topic details: `docs/progress/`.

## 2026-11-25 (session 4) · P5.3 live check, P5.4 consumer + topology

Branch `p5-rabbitmq` (in sync with origin at session start). Commit `19186a6` (docs: P5.3 live check).
**P5.4 code is uncommitted** (6 modified + 12 new files under `src/`, plus docs) — commit after the
review fixes below.

### Completed
- P5.3 live publish path (owner): returned → backoff retry → published after binding a temporary queue;
  AMQP properties and outbox row correct; worker startup with the broker stopped (give up / late broker /
  Ctrl+C → `SIGINT`, exit 0). Details: `docs/progress/messaging.md` → P5.3 → Verification.
- P5.4 implemented (plan approved: all 5 points, broker int tests in vhost `movies_test`): topology,
  `ReviewConsumer`, review handler, processing repository, message Zod schema, stub|fake generator,
  worker wiring. Design table, failure modes, observed broker semantics: `messaging.md` → P5.4.
- Requeue fallback gets a 5 s pause (explicit `nack(requeue=true)` is not counted by delivery-limit).
- `backend-reviewer` review of P5.4: no blockers; 6 findings (see Known issues).

### Decisions (owner, 2026-11-25)
- Constants: max 5 attempts, retry tiers 10s/30s/2m/5m, lease 120 s, deadline 90 s, prefetch 4, delivery-limit 10.
- Env `REVIEW_GENERATOR=stub|fake`, `REVIEW_FAKE_LATENCY_MS`, `REVIEW_FAKE_FAILURE_RATE` (fake refused in production).
- Broker integration tests in vhost `movies_test` (created by the owner).
- Double retry layers (in-process 3 × broker 5) kept for now; decide before enabling real Gemini.
- Requeue fallback: pause (option A), not channel close.

### Verification
- Assistant: `npx tsc -p .` 0; unit 384/384; 7 mutation checks caught (list in `messaging.md` → P5.4).
- Owner: `npm run test:integration` 77/78 (16 PG processing tests green; delivery-limit broker test failed:
  13 × `nack(requeue=true)` never dead-lettered). Test rewritten to emulate a consumer crash (channel
  close) → `review-topology.int.test.ts` rerun alone: 6/6 green. Full suite not rerun after that.
- Not verified: P5.4 live run (stub → succeeded; fake failure rate 1 → tiers → failed + DLQ; superseded);
  the requeue pause was added after the integration run (unit-tested only); `src/worker.ts` wiring has no
  automated test; exit code of the "startup failed" path (expected 1) not captured.

### Known issues
- **Review findings 1–6 awaiting the owner's decision** — details and options: `messaging.md` → P5.4 →
  Review. Assistant's recommendation: fix 2–6 now (setup isolation, pause in handler-throws fallback,
  per-claim lease token, deterministic concurrency test, missing test); finding 1 (dead-lettered message ⇒
  job `queued` forever) → option c now + reconciliation as P5.4b.
- Pending: re-queue `review.requested` rows dead-lettered during P5.3 (SQL in `messaging.md` → P5.4 →
  Verification; owner runs it after the P5.4 worker is live).
- Worker logs: `service` is `movies-api`; relay/publish-channel children write `component` twice (consumer
  uses a root child). Fix with a worker logger in P5.5.
- `retryDelayMs` (relay, cache-invalidation worker): effective cap 256 s, 5 min cap is dead code.
- Carried over: Gemini-dependent RAG ingest scripts fail by design; `git push` blocked in the sandbox;
  stale `[branch "p2-k6-baseline"]` in `.git/config`; `.env.example` needs `RABBITMQ_URL=` (unconfirmed) and
  the three `REVIEW_*` names (owner edits `.env*`); remote `p2-k6-baseline` / `p7-prompt-delimiters`
  deletion unconfirmed; P5.1 up → down → up not reported; no mutation check of review `ON CONFLICT`;
  low priority: possible `shutdown()` bug under `npm run dev --watch`.

### Next steps
1. Owner: decide on review findings 1–6 (recommendation above); assistant implements, reruns unit +
   mutation checks; owner reruns `npm run test:integration`.
2. Owner: P5.4 live run (steps in `messaging.md` → P5.4 → Verification).
3. Commit P5.4; apply the `CLAUDE.md` "Current state" update (awaiting OK): worker sentence + "; review
   consumer on `reviews.generate` (quorum, TTL retry queues, DLX `movies.dlx` → `reviews.generate.dlq`;
   `REVIEW_GENERATOR=stub|fake`) (P5.4)"; integration line + "; broker tests use RabbitMQ vhost `movies_test`".
4. Owner: re-queue P5.3 dead-lettered outbox rows.
5. If chosen: plan P5.4b reconciliation; then P5.5 metrics / alerts / dashboard (DLQ > 0, consumers = 0).
