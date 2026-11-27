# Current phase: P5 — RabbitMQ messaging and workers

_Read at session start. Active phase only; when it is finished, move this section back into `docs/learning/phases.md` (in phase order) and put the next phase here. Implementation details and verification: `docs/progress/messaging.md`._

## Steps (branch `p5-rabbitmq`)

- [x] P5.0 broker + Prometheus scrape + optional `RABBITMQ_URL` + recovering connection (`41eef19`)
- [x] P5.1 migration `review_jobs` + `message_outbox` (`dd57434`)
- [x] P5.2 API: 202 + job, `GET /v1/review-jobs/:id` (`4cf17fb`); Gemini stubbed at all call sites (`57d7b59`)
- [x] P5.3 outbox relay (worker process, publisher confirms) (`00f90a8`); live publish path verified by the owner 2026-11-25 (`docs/progress/messaging.md` → P5.3)
- [ ] **P5.4 consumer + topology — next: owner reruns integration → live run → commit** (`docs/progress/messaging.md` → P5.4). Plan approved 2026-11-25 (all 5 points, broker int tests in vhost `movies_test`); implemented, uncommitted. Review findings resolved 2026-11-27 (2–6 fixed, 1 → option c: documented + manual SQL + DLQ > 0 alert in P5.5); unit 388/388
- [ ] P5.4b (proposed, not approved) reconciliation of stale non-terminal review jobs (review finding 1 option b; plan first)
- [ ] P5.5 metrics / alerts / dashboard
- [ ] P5.6 graceful shutdown
- [ ] P5.7 exercises with the fake generator
- [ ] P5.8 `docs/progress/messaging.md`

## Phase plan (moved verbatim from `docs/learning-roadmap.md`, 2026-11-23)

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

**Plan and decisions (2026-11-23, updated 2026-11-25; P5.0–P5.3 done, P5.4 implemented and uncommitted, P5.5+ not started — status in `docs/progress/messaging.md`).** Owner decisions: `amqplib` directly (`amqplib@2.4.1`, ships its own types; `@types/amqplib` removed by the owner); reconnect = amqplib built-in recovery (assistant, 2026-11-23: replaces a hand-written loop, same intent); **no live Gemini** — business logic only, generator mocked in tests; synchronous review **replaced** by `202` + job; new `message_outbox` table for broker events, `cache_invalidation_outbox` untouched; dev-only fake generator (`REVIEW_GENERATOR=fake`, configurable latency / 503 share, `// LAB:`) for manual runs and exercises; relay runs in the worker process (API never connects to the broker); RabbitMQ **local via Homebrew** (not compose), optionally a 2–3 node local cluster for quorum queues.
Flow: `POST /v1/movies/:id/review` → one `PG.transaction` inserts `review_jobs` (queued, `movie_version`) + `message_outbox` (`review.requested`) → `202` + `Location: /v1/review-jobs/:id` (existing active/succeeded job for the same version is returned, no new one). Worker: relay (ConfirmChannel, mark published after confirm, SKIP LOCKED + lease) and consumer (`reviews.generate` quorum queue, prefetch, manual ack; job already done → ack; `movie.version` changed → `superseded`, no billable call; transient error → TTL retry queue with attempt header; permanent / exhausted → `failed` + DLX → DLQ). `GET /v1/review-jobs/:id` returns status and result.
Steps: P5.0 broker (brew) + Prometheus scrape (:15692) + optional `RABBITMQ_URL` config + connection with reconnect/backoff → P5.1 migration (`review_jobs`, `message_outbox`, partial unique index on `(movie_id, movie_version)` for queued/running/succeeded) → P5.2 API (202, GET job) → P5.3 relay → P5.4 consumer + topology → P5.5 metrics/alerts/dashboard → P5.6 graceful shutdown → P5.7 exercises with the fake generator → P5.8 `docs/progress/messaging.md`. Accepted failure mode: crash between Gemini and saving the result → regenerated after lease expiry (billable duplicate).
Fixed by P5.1–P5.2 for the next steps: message `review.requested` = `{ schemaVersion: 1, jobId, movieId, movieVersion }` (`src/modules/reviews/review-messages.ts`); relay claims `message_outbox` ordered by `(available_at, id)` (matches the pending index) and sends `message_id` as AMQP messageId; consumer acks a message whose job no longer exists (movie deleted → cascade); DB `attempts` are authoritative over AMQP headers; no lease sweeper (redelivery takes over an expired `running` lease). Fixed by P5.3 for the next steps (2026-11-23): exchange `movies.events` (topic, durable; `src/messaging/topology.ts`); messages are persistent, `mandatory`, `messageId` = outbox `message_id`, `type` = routing key, `contentType: application/json`; until a queue is bound every message is returned → retried → dead-lettered after 20 attempts (re-queue after P5.4); consumer topology goes into the worker's recovery `setup` next to `PublishChannel.open`; worker logger/`/metrics` in P5.5. Fixed by P5.4 (owner, 2026-11-25; details `messaging.md` → P5.4): quorum `reviews.generate` (delivery-limit 10) + DLX `movies.dlx` → `reviews.generate.dlq`; per-delay TTL retry queues 10s/30s/2m/5m (at-least-once dead-lettering); prefetch 4, max 5 attempts, lease 120 s, deadline 90 s; retry = confirmed copy then ack, `nack(requeue=true)` only as a paused fallback (not counted by delivery-limit on 4.x); env `REVIEW_GENERATOR=stub|fake` (+ `REVIEW_FAKE_LATENCY_MS`, `REVIEW_FAKE_FAILURE_RATE`); broker int tests in vhost `movies_test`; double retry layers (3 in-process × 5) kept until real Gemini is enabled. Open: optional `Retry-After` on 202; webhook/SSE only if a real push client appears (client polls today).
