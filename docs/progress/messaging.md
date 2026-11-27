# Messaging (P5): RabbitMQ, outbox relay, async review worker

_Started 2026-11-23 · branch `p5-rabbitmq`. Plan and owner decisions: `docs/learning/current-phase.md` → "Plan and decisions". No live Gemini: the review generator is mocked in tests and stubbed by default at runtime (`src/modules/rag/gemini-stub.ts`, returns "message from gemini"); configurable latency / 503 share for the exercises comes with the consumer (P5.4)._

## Status

| Step | State |
|---|---|
| P5.0 broker + config + connection | done: unit-tested; live `scripts/rabbitmq-ping.ts` OK (owner, 2026-11-23); Prometheus target `rabbitmq` UP after `rabbitmq-plugins enable rabbitmq_prometheus` (owner, 2026-11-23; the plugin is off by default in Homebrew, management on :15672 is a different plugin) |
| P5.1 schema (`review_jobs`, `message_outbox`) | done: migration `1795432527618_review_jobs_message_outbox.sql`; integration 36/36 and `migrate:up` on the app DB (owner, 2026-11-23); up → down → up on a disposable DB not reported |
| P5.2 API (`202` + job, `GET /v1/review-jobs/:id`) | done (2026-11-23): `tsc` 0, unit 282/282 (assistant); `src/routes` and `npm run test:integration` incl. `review-jobs.int.test.ts` (10 concurrent POSTs → 1 job, 1 message) green (owner); no mutation check |
| P5.3 outbox relay (publisher confirms) | done (2026-11-23): `tsc` 0, unit 322/322 (assistant); `npm run test:integration` green incl. `outbox-relay.int.test.ts`, worker start + Ctrl+C shutdown against the local broker OK (owner); live publish path (returned → retry, temporary queue → published) passed (owner, 2026-11-25) |
| P5.4 consumer + topology (quorum, retry TTL queues, DLX/DLQ) | implemented (2026-11-25, uncommitted): `tsc` 0, unit 384/384, 7 mutation checks caught (assistant); integration incl. broker in vhost `movies_test` green (owner). Review findings fixed 2026-11-27 (2–6 in code, 1 documented as a LAB limitation): unit 388/388, 5 more mutation checks caught (assistant); integration rerun and live run pending (owner) |
| P5.5 metrics, alerts, dashboard | 5.5a–b (worker `/metrics`, relay + consumer metrics) done 2026-11-27: `tsc` 0, unit 403/403, 7 mutation checks caught (assistant); `metrics-server.test.ts`, `src/routes`, live scrape OK (owner). 5.5c–f not started |
| P5.6 graceful shutdown | not started |
| P5.7 exercises | not started |

## P5.0 — what exists

| File | Role |
|---|---|
| `src/config/rabbitmq.ts` | Optional `RABBITMQ_URL` (`amqp://` / `amqps://` with a host). Unset → `rabbitMqConfig === null`; invalid → fail fast; the URL is never put into errors (may carry a password). |
| `src/infrastructure/rabbitmq.ts` | `connectRabbitMq({ url, connectionName, setup })`: amqplib 2.x built-in recovery + logging of every lifecycle event (never the URL). |
| `scripts/rabbitmq-ping.ts` | Manual live check: connect, print broker version, open/close a channel, disconnect. Declares and publishes nothing. |
| `observability/prometheus/prometheus.yml` | New scrape job `rabbitmq` → `host.docker.internal:15692`. |

Dependency: `amqplib@^2.4.1` (owner, 2026-11-23; ships its own TypeScript types — `@types/amqplib` removed by the owner because it describes the 0.10 API).

### Decisions

- **Built-in recovery instead of a hand-written reconnect loop** (deviation from the original plan wording "connection with reconnect/backoff", same intent). amqplib ≥ 2.0 has opt-in recovery; its changelog for 2.2–2.4.1 lists fixed races a hand-written loop would have to rediscover (connection lost while `setup` runs, throwing listeners ending recovery, `close` during setup). The mechanism stays explicit where it matters: channels, topology and consumers are recreated by our `setup` on every (re)connect.
- **Retry budget:** startup — 5 retries (≈ 0.5 + 1 + 2 + 4 + 8 s ± 20% jitter ≈ 15 s), then `connect` rejects and the worker exits (a wrong URL fails the start instead of hanging). Once connected — retry forever, delay capped at 30 s.
- **`waitForConnect: false` + listeners first:** failed attempts during startup are logged, and an `error` listener exists before any socket event (without it, a socket error is an uncaught exception that kills the process even though recovery would reconnect).
- **The API process never connects to the broker** (owner decision 5): the relay and consumers run in the worker process, so a broker outage doesn't touch `/readyz` or `POST` — events wait in the outbox.

### Failure modes (by design)

| Situation | Behaviour |
|---|---|
| Broker down at worker start | 5 logged retries, then exit 1 |
| Broker restarts while connected | `disconnect` → backoff → `connect` → `setup` re-run; unacked messages are redelivered by the broker (consumers must be idempotent) |
| `setup` fails permanently (e.g. queue redeclared with different arguments → `PRECONDITION_FAILED`) | Counted as a failed connect and retried forever: an endless reconnect loop in the logs, not a crash. Watch for it; P5.5 adds a metric. |
| Broker memory/disk alarm | `blocked` logged; publishes stall until `unblocked` (consumers keep working) |
| Publishes in flight when the connection drops | Lost from the channel's point of view; the relay (P5.3) marks outbox rows only after a confirm, so they are republished |

### Verification

- Assistant (2026-11-23): `npx tsc -p .` exit 0; unit tests 282/282 without `src/routes` (13 new: `src/config/rabbitmq.test.ts`, `src/infrastructure/rabbitmq.test.ts`); `promtool check config observability/prometheus/prometheus.yml` SUCCESS. Mutation checks, all caught: no `error` listener; listeners attached after the first connect; unbounded startup retries; URL in the log context.
- Fix after the owner's first ping run: `connectRabbitMq` defaulted to the root logger, which imports `env.ts` → a broker-only script failed with "PG_DATABASE … undefined". The logger is now a required option; the ping script brings its own. Checked: `env -i … node scripts/rabbitmq-ping.ts` without `PG_*` reaches the connect attempts (EPERM in the sandbox, retries logged).
- Owner (2026-11-23): `node --env-file-if-exists=.env scripts/rabbitmq-ping.ts` against the local broker — OK.
- Not verified: recovery behaviour against a real broker (stop/start during a run), the Prometheus target `rabbitmq` UP.

## P5.1 — schema

`review_jobs`: one row per review request. Statuses `queued → running → succeeded | failed | superseded` (transient error: `running → queued`). Invariants enforced by CHECKs: lease (`locked_by`/`locked_until`) exists iff `running`; `review` + `model` exist iff `succeeded`; `finished_at` iff terminal. Partial unique index on `(movie_id, movie_version)` for `queued/running/succeeded` → dedupe of concurrent POSTs via `ON CONFLICT ... DO NOTHING`; `failed`/`superseded` allow a new job. FK to `movies` with `ON DELETE CASCADE` (+ index on `movie_id`, otherwise every movie delete seq-scans the jobs); a consumer that finds no job acks.

`message_outbox`: same claim/lease/retry/dead-letter columns as `cache_invalidation_outbox`, plus `message_id` (stable AMQP messageId across republishes), `routing_key` (exchange fixed in code), `payload jsonb` (object). Pending partial index `(available_at, id)`; the relay orders by the same columns.

Decisions (owner, 2026-11-23): `text` + CHECK instead of ENUM (like `movies_status_valid`); attempts in the DB are authoritative (AMQP headers are lost on republish); no sweeper for expired leases (redelivery after a consumer crash finds `running` with an expired lease and takes it over). `src/test/integration-db.ts` truncates the new tables (the FK would otherwise make `TRUNCATE movies` fail).

Finding (hypothesis, check in P3 with `EXPLAIN`): the existing cache-invalidation worker claims with `ORDER BY id` over the `(available_at, id)` index → likely a Sort on a large backlog.

## P5.3 — outbox relay

| File | Role |
|---|---|
| `src/worker.ts` | Worker process (`npm run worker`): PG → recovering connection (`setup` = open publish channel) → relay loop. Exits 1 without `RABBITMQ_URL` or when the broker is unreachable at start (~15 s). Signal during startup → close PG, exit immediately (nothing in flight; a pending connect would otherwise keep the process alive). LAB shutdown: relay finishes its batch, then channel, connection, PG close (consumer draining: P5.6). |
| `src/messaging/topology.ts` | `EVENTS_EXCHANGE = "movies.events"` (topic, durable). Queues/bindings: P5.4. |
| `src/messaging/publish-channel.ts` | Holds the `ConfirmChannel`. Connection lost → recovery calls `open(newModel)`. Channel-only close (e.g. 404 on a deleted exchange) → reopen on the same connection every 5 s while it is alive (a reopen timer left by the old connection is cleared on `open(newModel)` — amqplib closes channels before the connection's `close`). No channel or connection `blocked` → `current()` is null, relay claims nothing. |
| `src/workers/outbox-relay.ts` | Claim (`SKIP LOCKED`, lease 30 s, `ORDER BY available_at, id`, batch 50) → publish (persistent, `mandatory`, `messageId = message_id`, `type = routing_key`) → confirms with a 10 s batch deadline → `published_at` for acked rows; retry/backoff (1 s doubling, effective cap 256 s: exponent capped at 8, + up to 1 s jitter) or dead-letter after 20 attempts otherwise. |
| `src/workers/outbox-relay-runner.ts` | Poll loop (1 s when idle), channel read per batch. |

### Decisions (owner, 2026-11-23)

- Exchange `movies.events`; one topic exchange for all domain events (future `movie.updated` etc.).
- **`mandatory` + `basic.return` → retry.** Without `mandatory` the broker acks an unroutable message and drops it — the relay would mark it published and the message is gone. RabbitMQ sends `basic.return` before `basic.ack` on the same channel (amqplib processes frames in order), so the confirm callback knows. Consequence until P5.4 binds a queue: every `review.requested` cycles through retries and dead-letters after 20 attempts (1 + 2 + … + 256 s, then 256 s each ≈ 51 min). Alternative rejected for now: alternate exchange → `unroutable` queue.
- Metrics deferred to P5.5 (the worker needs its own `/metrics` port). Until then the batch log line has counts per publish result (`published | returned | publish_failed | timeout`); each failed message logs `publishResult` and the action `result` (`retry_scheduled | dead_lettered | lease_lost`); dead-letters log at `error`. `lease_lost` = the reschedule UPDATE matched no row, so no outcome is claimed.
- Confirm deadline (10 s) < lease (30 s): waiting past the lease would let another relay claim the row while ours is still in flight.

### Failure modes

| Situation | Behaviour |
|---|---|
| Broker down | No channel → nothing claimed, attempts not burned; rows wait in the outbox |
| Connection drops mid-batch | Unconfirmed publishes fail with `channel closed` → retry; some of them may have reached the broker → duplicates with the same `messageId` |
| Confirm after the deadline | Row retried although the broker has it → duplicate |
| Crash / PG down between confirm and `UPDATE` | Row republished after the lease (30 s) → duplicate |
| Lease lost while waiting (shouldn't happen: deadline < lease) | `UPDATE ... AND locked_by = $me` marks / reschedules nothing; `lease_lost` warning; the new owner republishes |
| Write buffer full (`publish()` → false) | Waits for `drain` (bounded by the deadline); rest of the batch → `timeout` |
| Broker alarm (`blocked`) | Relay stops claiming until `unblocked` (attempts not burned). A batch already in flight when the alarm starts times out → retry; its buffered frames are flushed after the alarm → duplicates |
| Late `basic.return` of an earlier (timed-out) publish of the same row during its retry batch | Retry classified `returned` even if routed (returns are matched by the stable `messageId`) → extra retry + duplicate, never a lost message |

All duplicates carry the same AMQP `messageId`; the consumer (P5.4) must be idempotent (job status check).
LAB: no ordering guarantee across retries / parallel relays (fine for one message per job).

### Verification

- Assistant (2026-11-23): `npx tsc -p .` 0; unit 322/322 (`src/config src/infrastructure src/modules src/workers src/utils src/messaging`; new: `outbox-relay.test.ts` 17, `publish-channel.test.ts` 12). Mutation checks, all caught and restored: ignore `basic.return` (2 failed), `mandatory: false` (1), no wait for `drain` (2), no reopen-timer clear in `open()` (1), ignore `blocked` (1), no `closing` check in `open()` (1), no `rowCount` check in reschedule (2).
- Review (`backend-reviewer`, 2026-11-23): fixed — signal during startup left the worker hanging with the relay on a closed pool; stale reopen timer from the old connection blocked the reopen on the new one; `blocked` burned attempts; reschedule logged outcomes on 0 rows. Documented — late `basic.return` (table above). Not covered by tests: `src/worker.ts` startup/shutdown (top-level script; check manually: Ctrl+C while the broker is stopped → exits within ~1 s).
- Owner (2026-11-23, passed; counts not reported): `npm run test:integration` incl. `src/workers/outbox-relay.int.test.ts` (7: mark after ack, unroutable → backoff, dead-letter, two concurrent relays → no message published twice, active/expired lease + `available_at`, order, lease lost → not marked). The concurrency test proves no duplicates, not SKIP LOCKED specifically: plain `FOR UPDATE` would also pass (the lease condition is re-checked after the lock wait).
- Live check (owner): worker start → "Publish channel open", "Worker started"; Ctrl+C → shutdown in ~0.6 s, PG pools closed (2026-11-23).
- Live publish path (owner, 2026-11-25, passed), new movie → `POST /v1/movies/:id/review`:
  - no queue bound → `publishResult=returned`, `lastError="unroutable: no queue bound to movies.events for review.requested"`, `result=retry_scheduled`; `delayMs` 4029 → 8759 → 16789 for attempts 3 → 4 → 5 (observed intervals +≤1 s idle poll); same `messageId` on every attempt;
  - temporary queue bound → next retry `published=1`; message in the queue: `message_id` = outbox `message_id`, `type=review.requested`, `delivery_mode=2`, `content_type=application/json`, payload `{jobId, movieId, movieVersion, schemaVersion: 1}`, exactly one message;
  - outbox row: `attempts=6` (5 returned + 1 success; claim increments), `published_at` set, `locked_by`, `dead_lettered_at`, `last_error` NULL.
- Worker startup with the broker stopped (owner, 2026-11-25, passed): recovery gives up → "Worker failed to start", PG pools closed, exit; broker started during the retries → connects, "Publish channel open", "Worker started"; Ctrl+C while reconnecting → "Worker stopping during startup" `reason=SIGINT`, PG pools closed within 1 ms, exit 0.
  ```
  npm run worker                                # "Publish channel open", "Worker started"
  curl -si -X POST localhost:3000/v1/movies/<id>/review   # 202
  # worker log: "Outbox message not published; retry scheduled", publishResult=returned (no queue yet)
  # temporary queue via the management HTTP API (durable: true — the first try with durable:false
  # failed, error not captured; hypothesis: deprecated transient non-exclusive queues in 4.x):
  curl -sS -u guest:guest -X PUT localhost:15672/api/queues/%2F/tmp-review \
    -H 'content-type: application/json' -d '{"durable":true}'                              # 201
  curl -sS -u guest:guest -X POST localhost:15672/api/bindings/%2F/e/movies.events/q/tmp-review \
    -H 'content-type: application/json' -d '{"routing_key":"review.#"}'                    # 201
  # next retry → "Outbox relay batch done" published=1
  curl -sS -u guest:guest -X POST localhost:15672/api/queues/%2F/tmp-review/get \
    -H 'content-type: application/json' -d '{"count":5,"ackmode":"ack_requeue_true","encoding":"auto"}'
  curl -sS -u guest:guest -X DELETE localhost:15672/api/queues/%2F/tmp-review
  ```
- Not verified: reconnect mid-batch against a real broker (the kill-the-broker exercise is P5.7); exit code of the "startup failed" path not captured (expected 1).

## P5.4 — consumer + topology

| File | Role |
|---|---|
| `src/messaging/topology.ts` | `movies.events` → `reviews.generate` (quorum, `x-delivery-limit` 10, DLX `movies.dlx`) → `reviews.generate.dlq`; retry queues `reviews.generate.retry.{10s,30s,2m,5m}` (quorum, `x-message-ttl`, dead-letter to `""` / `reviews.generate`). All dead-lettering queues: `at-least-once` + `x-overflow: reject-publish`. Changing a queue argument needs the queue deleted first (406 otherwise → endless reconnect). |
| `src/messaging/review-consumer.ts` | Confirm channel: topology, `prefetch(4)`, `consume` with manual ack; each delivery bound to its channel and settled at most once; `publishRetry` = default exchange + `mandatory` + confirm (10 s) + `basic.return` matched by `x-retry-id`. Channel-only close / consumer cancelled → reopen after 5 s (as `PublishChannel`). `start()` (used by the worker's recovery `setup`) never rejects: a failed `open()` closes its half-opened channel and retries on the same connection after 5 s, so a consumer topology error doesn't stop the outbox relay. Handler-threw fallback: pause 5 s → `nack(requeue=true)`. |
| `src/workers/review-handler.ts` | Decision per delivery (table below); settings `REVIEW_CONSUMER_SETTINGS`: max 5 attempts, deadline 90 s, lease 120 s. |
| `src/modules/reviews/review-job-processing.repository.ts` | `claim` (`SELECT … FOR UPDATE OF j` + transition, one transaction), `complete` / `release` / `fail` guarded by `locked_by = $leaseToken AND status = 'running'`. The token is per claim (`<workerId>:<uuid>`, returned by `claim`), not per process: with prefetch 4, two deliveries of one job in one process must not pass each other's guard after a lease takeover. |
| `src/modules/reviews/review-messages.ts` | Zod validation of `review.requested` (queue = trust boundary). |
| `src/modules/reviews/review-generator.ts`, `src/config/review-generator.ts` | `REVIEW_GENERATOR=stub` (default: real review service, Gemini stub) \| `fake` (LAB, dev-only, refused with `NODE_ENV=production`): `REVIEW_FAKE_LATENCY_MS` (2000), `REVIEW_FAKE_FAILURE_RATE` (0..1, retryable 503). |
| `src/worker.ts` | recovery `setup` = publish channel (`open`, may fail the setup) + review consumer (`start`, never fails it); shutdown closes the consumer channel first (LAB: in-flight not awaited → redelivered; P5.6). |

### Decision per delivery (DB first, then broker)

| Job state at claim | DB | Broker |
|---|---|---|
| invalid message | — | nack(false) → DLQ |
| missing (movie deleted → cascade) | — | ack |
| succeeded / failed / superseded | — | ack (duplicate) |
| running, live lease | — | retry copy 30s → ack |
| movie version changed | superseded | ack (no generation) |
| attempts ≥ 5 | failed | nack(false) → DLQ |
| queued / running with expired lease | running, attempts+1, lease 120 s | generate ↓ |
| → success | succeeded (guarded) | ack |
| → transient error (retryable, unknown, deadline) | queued (guarded) | retry copy by attempt (10s/30s/2m/5m) → ack; last attempt → failed + DLQ |
| → permanent error (`RagInputError`, non-retryable) | failed (guarded) | nack(false) → DLQ |
| guarded UPDATE matched 0 rows | — | ack (`lease_lost`: new owner decides) |
| PostgreSQL error | — | retry copy 10s (no attempt counted) → ack |
| retry copy not confirmed / returned | — | pause 5 s → nack(true) (NOT counted by delivery-limit, see below) |

### Failure modes

| Situation | Behaviour |
|---|---|
| Crash after claim, before outcome | Message redelivered; job `running` with lease → `lease_busy` → retry 30s until the lease expires → taken over (attempt counted; billable duplicate if generation had finished) |
| Crash after retry copy confirmed, before ack | Original redelivered + copy → two deliveries; the second sees the job state (duplicate / lease_busy) |
| Consumer crash loop on one message | Broker dead-letters after `x-delivery-limit` 10; DB `attempts` also stop it at 5 (claim counts) |
| Retry publish keeps failing (retry queue deleted, alarm) | `nack(requeue=true)` after a 5 s pause. Transient path: bounded by DB attempts (each redelivery claims again). `lease_busy`: cycles every ~5 s until the lease expires. PostgreSQL AND publish down: cycles every ~5 s until one recovers (LAB: rate-limited, not bounded) |
| Slow generation > lease | Another consumer takes over; first one's `complete` → `lease_lost`, result discarded |
| Movie PATCHed after claim | Review for the job's version is stored (job is version-specific) |
| Retry queue deleted at runtime | `basic.return` → requeue; on reconnect/reopen the topology is re-declared |
| Message lost anyway (e.g. queue deleted with messages) | Job stays `queued` forever. LAB: production would run a reconciliation job republishing old `queued` jobs |
| Message dead-lettered while its job is not terminal (delivery-limit after repeated crashes before ack; or the P5.3 relay dead-lettering the outbox row in PG — that one never reaches the broker DLQ) | Job stays `queued`/`running` forever; `POST` returns the stuck job and the partial unique index blocks a new one until the movie is PATCHed. LAB (owner, 2026-11-27: option c): no DLQ consumer; detection = DLQ > 0 alert (P5.5), recovery = manual SQL below; reconciliation proposed as P5.4b. Rejected: a DLQ consumer marking the job `failed` (race with a legit copy waiting in a retry queue → false `failed`), also with a requeue counter (counter header lost through `publishRetry`; each round can crash the worker up to 10 times; doesn't cover the relay path) |

Manual recovery for finding 1 (owner; makes the job terminal so a new `POST` creates a fresh job):

```sql
-- stale non-terminal jobs (nothing legitimately waits longer than ~8 min of retry tiers)
SELECT id, movie_id, status, attempts, locked_until, created_at, last_error FROM review_jobs
WHERE status IN ('queued', 'running') AND created_at < now() - interval '30 minutes';
-- per job, after checking reviews.generate.dlq / the retry queues hold nothing for it
UPDATE review_jobs
SET status = 'failed', finished_at = now(), locked_by = NULL, locked_until = NULL,
    last_error = 'manual: message dead-lettered, job never finished'
WHERE id = '<jobId>'
  AND (status = 'queued' OR (status = 'running' AND locked_until < now()));
```
| Double retry layers | `generateWithRetries` retries up to 3× in-process → worst case 5 × 3 = 15 billable calls per job; decide before enabling real Gemini (stub today) |

### Broker semantics observed (local RabbitMQ 4.x, 2026-11-25, `review-topology.int.test.ts`)

- `x-delivery-limit` counts **failed deliveries only**: a message taken unacked and returned by a closed channel (consumer crash) is dead-lettered with `x-death` reason `delivery_limit` after the limit.
- An explicit `nack(requeue=true)` is **not** a failed delivery: 13 requeues in a row → no `x-delivery-count` header, never dead-lettered. First version of the test assumed otherwise and failed; the handler's requeue fallback got a 5 s pause because of this.
- `nack(requeue=false)` → DLQ with reason `rejected`; retry queue TTL → back to the work queue with reason `expired` (~10 s for the first tier).
- A non-durable, non-exclusive queue could not be declared via the management API (P5.3 live check); cause not captured.

### Verification

- Assistant (2026-11-25): `npx tsc -p .` 0; unit 384/384 (`src/config src/infrastructure src/modules src/workers src/utils src/messaging`; new: `review-handler.test.ts` 24, `review-consumer.test.ts` 16, `topology.test.ts` 9, `config/review-generator.test.ts` 8, `reviews/review-generator.test.ts` 5). Mutation checks, all caught and restored: ack before the retry publish (8 failed), every error transient (3), no settle-once guard (1), ignore `basic.return` on retry (1), retry tier off by one (4), `lease_lost` treated as success (1), no pause before the requeue fallback (1).
- Owner (2026-11-25, passed): `npm run test:integration` incl. `review-job-processing.repository.int.test.ts` (16: claim states, takeover, concurrent claims, guarded outcomes) and `review-topology.int.test.ts` (6, broker in vhost `movies_test`: arguments accepted, routing, reject → DLQ, consumer crash past the delivery limit → DLQ, TTL → back to the work queue, ReviewConsumer + confirmed retry publish).
- Assistant (2026-11-27, review fixes): `npx tsc -p .` 0; unit 388/388 (`npx vitest run --exclude 'src/routes/**'`; `src/routes` needs local port binding → owner). New: handler — `release`/`fail` throwing after generation → `infrastructure_retry` (2); consumer — handler-threw requeue only after the pause (rewritten), `start()` survives topology / consume failure and retries once (2). Mutation checks, all caught and restored: no `await` on `handleGenerationError` (2 failed), `workerId` instead of the lease token in `complete` (1), no pause in the handler-threw fallback (1), `start()` rethrows (2), half-opened channel not closed (1).
- Owner (2026-11-27, passed): `npm run test:integration` after the review fixes, incl. the new int tests below. `FOR UPDATE` mutation check not reported.
- New int tests: deterministic concurrent claim (transaction A holds the row lock until `pg_stat_activity` shows B waiting → B `lease_busy`, attempts 1); same worker claims one job twice after lease expiry → different tokens, stale `complete` → false. Mutation check for the owner: remove `FOR UPDATE OF j` in `claim` → the concurrent-claim test must fail (B `claimed`, attempts 2).
- Not verified: the requeue pause against a real broker (unit-tested + mutation check only); `src/worker.ts` wiring (no automated test).
- Pending (owner): live run, then re-queue the outbox rows dead-lettered during P5.3 (no queue was bound then):
  ```
  npm run worker            # "Review consumer started", "Worker started" reviewGenerator=stub
  # POST /v1/movies/<id>/review → GET /v1/review-jobs/<jobId>: succeeded, model "stub"
  REVIEW_GENERATOR=fake REVIEW_FAKE_FAILURE_RATE=1 REVIEW_FAKE_LATENCY_MS=200 npm run worker
  # POST review → logs retry_scheduled via retry.10s/30s/2m/5m, then exhausted (~8 min);
  # job failed, message in reviews.generate.dlq
  # stop worker → POST review → PATCH the movie → start worker → result=superseded
  ```
  ```sql
  SELECT id, attempts, dead_lettered_at FROM message_outbox
  WHERE routing_key = 'review.requested' AND dead_lettered_at IS NOT NULL AND published_at IS NULL;
  UPDATE message_outbox SET dead_lettered_at = NULL, attempts = 0, available_at = now(), last_error = NULL
  WHERE routing_key = 'review.requested' AND dead_lettered_at IS NOT NULL AND published_at IS NULL;
  ```

### Review (`backend-reviewer`, 2026-11-25) — resolved 2026-11-27

Owner decision (2026-11-27): fix 2–6 in P5.4; finding 1 → option (c) (documented LAB limitation + manual recovery, see Failure modes; DLQ > 0 alert in P5.5), reconciliation (b) as a separate step P5.4b (plan first, not approved). Fixes: 2 → `ReviewConsumer.start()`; 3 → pause in the handler-threw fallback; 4 → per-claim lease token; 5 → deterministic int test; 6 → unit tests (details in Verification).

No blockers (ack/nack order, settle-once per channel, all UPDATEs vs the CHECK constraints and the partial unique index, reopen/recovery and `basic.return` matching checked). Findings:

1. **Dead-lettered message ⇒ job `queued` forever.** Paths: delivery-limit after repeated crashes/restarts with the message in flight (channel close counts), or the P5.3 relay dead-lettering an outbox row. `POST` then returns the stuck job and the partial unique index blocks a new one until the movie is PATCHed. Options: (a) DLQ consumer marks `queued` → `failed` — race: a duplicate can be dead-lettered while the legit copy waits in a retry queue → false `failed` (recoverable by a new POST); (b) reconciliation re-enqueueing `queued` jobs older than N min (classic fix, also covers P5.3); (c) document + DLQ > 0 alert (P5.5). Assistant recommends (c) now + (b) as a separate step.
2. Consumer topology failure in the recovery `setup` (`src/worker.ts`) rejects the whole setup → recovery closes the model → the outbox relay stops too (startup: exit; later: endless reconnect). Fix: catch `reviewConsumer.open` errors in `setup`, log, reopen only the consumer.
3. `review-consumer.ts` handler-throws fallback requeues without the pause → hot loop if it ever fires. Fix: same `requeueDelayMs`.
4. Lease guard is per process (`workerId`), not per claim: two deliveries of one job in one process (prefetch 4) pass each other's `locked_by` guard after a lease expiry → extra billable generation. Fix: per-claim token in `locked_by`, returned by `claim`, passed to `complete`/`release`/`fail`.
5. Concurrent-claim int test isn't deterministic (passes without `FOR UPDATE` if the first transaction commits first). Fix: hold transaction A open on a separate client, assert B waits, commit, assert `lease_busy`; mutation-check by removing `FOR UPDATE`.
6. No unit test for `release`/`fail` throwing after generation (a missing `await` in `return await handleGenerationError` would escape to the fallback unnoticed).

Not verified by the reviewer: `at-least-once` + `x-dead-letter-exchange: ""` on other 4.x versions; duplicates of retry copies under a broker alarm.

## P5.5 — metrics, alerts, dashboard

Plan approved by the owner 2026-11-27 (all points): 5.5a worker `/metrics` → 5.5b app metrics → commit → owner checks the per-queue broker series with `curl` → 5.5c scrape jobs → 5.5d alerts + promtool tests → 5.5e dashboard → 5.5f drills. Decisions: `WORKER_METRICS_PORT` (default 3002); `SERVICE_NAME=movies-api|movies-worker` (enum, default `movies-api`; `npm run worker` sets `movies-worker`) for logs and the metrics `service` label; one shared `metricsRegistry` (the worker also exposes API series at 0 — existing outbox alerts get `job="movies-api"` in 5.5d).

### 5.5a–b (implemented 2026-11-27)

| File | Role |
|---|---|
| `src/infrastructure/metrics-server.ts` | `node:http`, `GET /metrics` only (404 otherwise, 500 if collecting fails); `close()` also closes idle keep-alive scrape connections. LAB: no auth, all interfaces. |
| `src/worker.ts` | `setDefaultLabels({ service })` from `SERVICE_NAME` (warns if not `movies-worker`); metrics server starts **first** (so `up` = process alive while waiting for PG/broker; a taken port → exit 1) and closes **last**. |
| `src/config/env.ts`, `src/infrastructure/logger.ts`, `package.json` | `SERVICE_NAME`, `WORKER_METRICS_PORT`; logger `service` from config; `worker` script sets `SERVICE_NAME=movies-worker` (`--env-file` doesn't override it). |
| `src/infrastructure/metrics.ts` | New series, all labelled ones pre-created at 0 (below). |

| Metric | Type | Labels / meaning |
|---|---|---|
| `message_outbox_publish_total` | counter | `result`: `published \| returned \| publish_failed \| timeout` (broker answer per claimed row) |
| `message_outbox_events_total` | counter | `result`: `published` (confirmed and marked) `\| retry_scheduled \| dead_lettered \| lease_lost \| db_error` |
| `message_outbox_pending_messages`, `message_outbox_oldest_pending_age_seconds`, `message_outbox_dead_lettered_messages`, `message_outbox_backlog_last_refresh_timestamp_seconds` | gauges | sampled every 10 s by the relay loop (also while the broker is down), one query; dead-lettered = state that survives restarts (finding 1, relay path). LAB: sequential scan of `message_outbox` (published rows never deleted), not measured |
| `review_deliveries_total` | counter | `outcome`: the 12 `ReviewOutcome` values + `handler_threw` (consumer bug path) |
| `review_generation_duration_seconds` | histogram | `outcome`: `ok \| error`; generator call incl. in-process retries, buckets to 90 s (covers the fake generator, which bypasses `rag_stage_duration_seconds`) |

Verification (assistant, 2026-11-27): `npx tsc -p .` 0; unit 403/403 (excluding `src/routes` and `metrics-server.test.ts`, both need local port binding). Mutation checks, all caught and restored: unmarked confirmed rows not counted as `lease_lost` (1), handler outcome not counted (4), generation error observed as `ok` (1), backlog refresh not throttled (1), `handler_threw` not counted (1), event series not pre-created (1; first version of that test passed because earlier tests had created the series → now checks a fresh module), `db_error` not counted (1).
Owner (2026-11-27, passed): `metrics-server.test.ts` + `src/routes`; live `npm run worker` → `localhost:3002/metrics` shows all new series pre-created at 0 with `service="movies-worker"`, backlog refresh timestamp set. Broker `/metrics/detailed` (`queue_coarse_metrics`) confirmed: `rabbitmq_detailed_queue_messages{,_ready,_unacked}{vhost="/",queue=…}` for all 6 review queues; aggregated `/metrics` has `rabbitmq_global_messages_dead_lettered_{maxlen,rejected}_total{queue_type,dead_letter_strategy}`. Not yet seen (output cut by `head`): `rabbitmq_detailed_queue_consumers`, `rabbitmq_global_messages_{redelivered,confirmed,received}_total`.
Commands used:
```
curl -s 'localhost:15692/metrics/detailed?vhost=/&family=queue_coarse_metrics&family=queue_consumer_count' | grep -E 'reviews\.generate' | head -20
curl -s localhost:15692/metrics | grep -E '^rabbitmq_global_messages_(redelivered|dead_lettered|confirmed|received)' | head
```

## Setup (owner, Homebrew)

```
brew install rabbitmq                        # if not installed
brew services start rabbitmq
rabbitmqctl version                          # quorum queues: >= 3.8 (4.x expected)
rabbitmq-plugins list | grep -E 'prometheus|management'
rabbitmq-plugins enable rabbitmq_prometheus rabbitmq_management   # if not [E*]
curl -s localhost:15692/metrics | head -3    # metrics endpoint
```
`.env`: `RABBITMQ_URL=amqp://localhost:5672` (default `guest` user — allowed only from localhost, fine for the lab). `.env.example`: add the variable name (`RABBITMQ_URL=`) — the assistant cannot read or edit `.env*` files.

Live check:
```
node --env-file-if-exists=.env scripts/rabbitmq-ping.ts
# expected: "connected: RabbitMQ <version>", "channel opened and closed", "connection closed"
brew services stop rabbitmq && node --env-file-if-exists=.env scripts/rabbitmq-ping.ts
# expected: 5 "reconnect scheduled" log lines with growing delayMs, then exit 1 (~15 s)
brew services start rabbitmq
```
Prometheus: reload the config (`docker compose -f observability/compose.yml --env-file observability/.env restart prometheus`), then Status → Targets → `rabbitmq` UP.

Cluster (2–3 nodes, later, before the quorum exercises in P5.7): 2 nodes are worse than 1 for quorum queues (a majority of 2 is 2 — losing either node stops writes); use 3.
