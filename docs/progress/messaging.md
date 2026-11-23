# Messaging (P5): RabbitMQ, outbox relay, async review worker

_Started 2026-11-23 · branch `p5-rabbitmq`. Plan and owner decisions: `docs/learning/current-phase.md` → "Plan and decisions". No live Gemini: the review generator is mocked in tests and stubbed by default at runtime (`src/modules/rag/gemini-stub.ts`, returns "message from gemini"); configurable latency / 503 share for the exercises comes with the consumer (P5.4)._

## Status

| Step | State |
|---|---|
| P5.0 broker + config + connection | done: unit-tested; live `scripts/rabbitmq-ping.ts` OK (owner, 2026-11-23); Prometheus target `rabbitmq` UP after `rabbitmq-plugins enable rabbitmq_prometheus` (owner, 2026-11-23; the plugin is off by default in Homebrew, management on :15672 is a different plugin) |
| P5.1 schema (`review_jobs`, `message_outbox`) | done: migration `1795432527618_review_jobs_message_outbox.sql`; integration 36/36 and `migrate:up` on the app DB (owner, 2026-11-23); up → down → up on a disposable DB not reported |
| P5.2 API (`202` + job, `GET /v1/review-jobs/:id`) | done (2026-11-23): `tsc` 0, unit 282/282 (assistant); `src/routes` and `npm run test:integration` incl. `review-jobs.int.test.ts` (10 concurrent POSTs → 1 job, 1 message) green (owner); no mutation check |
| P5.3 outbox relay (publisher confirms) | done (2026-11-23): `tsc` 0, unit 322/322 (assistant); `npm run test:integration` green incl. `outbox-relay.int.test.ts`, worker start + Ctrl+C shutdown against the local broker OK (owner); live publish path (returned → retry, temporary queue → published) not yet run |
| P5.4 consumer + topology (quorum, retry TTL queues, DLX/DLQ) | not started |
| P5.5 metrics, alerts, dashboard | not started |
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
- Live check (owner): worker start → "Publish channel open", "Worker started"; Ctrl+C → shutdown in ~0.6 s, PG pools closed (2026-11-23). Publish path and Ctrl+C during startup (broker stopped) still pending:
  ```
  npm run worker                                # "Publish channel open", "Worker started"
  curl -si -X POST localhost:3000/v1/movies/<id>/review   # 202
  # worker log: "Outbox message not published; retry scheduled", result=returned (no queue yet)
  # temporary queue to see a successful publish (delete afterwards):
  rabbitmqadmin declare queue name=tmp-review durable=false
  rabbitmqadmin declare binding source=movies.events destination=tmp-review routing_key='review.#'
  # next retry → "Outbox relay batch done" published=1; message visible in tmp-review
  rabbitmqadmin delete queue name=tmp-review
  ```
- Not verified: live broker (confirms, returns, reconnect mid-batch); the kill-the-broker exercise is P5.7.

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
