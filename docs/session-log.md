# Session checkpoint

Last session only; rewritten on each save. Previous checkpoints: `docs/sessions/archive/` (history, not read at session start).
"owner" = verified by the repository owner outside the assistant sandbox. Plan: `docs/learning-roadmap.md`, active phase: `docs/learning/current-phase.md`; per-topic details: `docs/progress/`.

## 2026-11-27 (session 5) · P5.4 review fixes + commit, P5.5 metrics/alerts/dashboard

Branch `p5-rabbitmq`, 5 commits ahead of origin at save time (push by the owner, sandbox blocks it):
`77f976d` P5.4, `d460ca0` P5.5a–b, `30d4838` P5.5c–e, plus this docs commit.

### Completed
- P5.4 review findings: 2 `ReviewConsumer.start()` (consumer topology failure no longer stops the relay),
  3 pause in the handler-threw requeue, 4 per-claim lease token (`<workerId>:<uuid>` in `locked_by`),
  5 deterministic concurrent-claim int test, 6 unit tests for `release`/`fail` throwing. Finding 1 → option c
  (documented LAB limitation + manual SQL, `messaging.md` → P5.4 → Failure modes); DLQ-consumer variants
  (incl. a requeue counter) rejected with reasons. Committed as P5.4.
- P5.5a–b: worker `/metrics` (`node:http`, `WORKER_METRICS_PORT` 3002), `SERVICE_NAME` enum for logs + metrics
  label, `message_outbox_*` counters + backlog gauges, `review_deliveries_total`, `review_generation_duration_seconds`.
- P5.5c–e: scrape jobs `movies-worker`, `rabbitmq-detailed`; 8 alerts in group `messaging` + promtool tests +
  runbooks; existing outbox alerts filter `job="movies-api"`; dashboard "Movies Worker (P5)".
- `CLAUDE.md` "Current state" updated (P5.4 consumer, vhost `movies_test`, P5.5 env/metrics/observability).

### Decisions (owner, 2026-11-27)
- Finding 1: option c now, reconciliation (b) stays proposed as P5.4b.
- P5.5 plan approved as a whole: port 3002; `SERVICE_NAME` via config (option 2a); shared metrics registry
  (other process's series at 0, alerts filter by `job`); commits after 5.5b and after 5.5e.

### Verification
- Assistant: `npx tsc -p .` 0; unit 403/403 (excluding `src/routes`, `metrics-server.test.ts`: local port binding);
  mutation checks caught: 5 (P5.4 fixes) + 7 (P5.5 metrics; one test first passed vacuously, fixed) + 6 rule
  mutations (1 not caught by design, see `messaging.md` → 5.5c–e); `promtool check config|rules`, `promtool test rules` green.
- Owner: `npm run test:integration` green after the P5.4 fixes; `metrics-server.test.ts` + `src/routes` green;
  live worker `/metrics` with `service="movies-worker"`; broker per-queue series incl. `rabbitmq_detailed_queue_consumers`;
  Prometheus picked up the new targets.
- Not verified: P5.4 live run (stub → succeeded, fake → tiers → DLQ, superseded); no alert fired live yet; dashboard
  not opened in Grafana; `rabbitmq_global_messages_redelivered_total` and `..._dead_lettered_{delivery_limit,expired}_total`
  names (dashboard only); `FOR UPDATE` mutation of the int test not reported; `src/worker.ts` wiring has no automated test.

### Known issues
- `.env`: `SERVICE_NAME` must be a single value (`movies-api`) or absent — `movies-api|movies-worker` literally breaks
  `npm run dev` (owner said it was added; unconfirmed where/how).
- Review finding 1 open by design (stuck non-terminal jobs; detection: DLQ / message_outbox dead-letter alerts).
- `ReviewDeadLetterQueueNotEmpty` fires until the DLQ is purged by hand (by design); `ReviewQueueBacklog` threshold is a guess.
- `refreshMessageOutboxBacklogMetrics`: sequential scan of `message_outbox` every 10 s, published rows never deleted (LAB, not measured).
- Carried over: `retryDelayMs` effective cap 256 s (5 min cap dead code); re-queue P5.3 dead-lettered outbox rows
  (SQL in `messaging.md` → P5.4 → Verification); stale `[branch "p2-k6-baseline"]` in `.git/config`; remote
  `p2-k6-baseline` / `p7-prompt-delimiters` deletion unconfirmed; P5.1 up → down → up not reported; no mutation check
  of review `ON CONFLICT`; possible `shutdown()` bug under `npm run dev --watch`.

### Next steps
1. Owner: `git push` (5–6 commits ahead).
2. Owner: P5.5f drills — stop worker → `WorkerDown` + `ReviewConsumersMissing`, restart → resolved; fake generator
   with failure rate 1 → retry tiers → `exhausted` → `ReviewDeadLetterQueueNotEmpty` (also the P5.4 live run);
   superseded case; record in the drill log (`docs/progress/observability.md`). Open the dashboard.
3. Owner: re-queue P5.3 dead-lettered outbox rows once the worker is live.
4. Then P5.6 graceful shutdown (consumer draining), or plan P5.4b reconciliation first (owner's choice).
