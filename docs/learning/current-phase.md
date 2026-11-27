# Current phase: P6 — Distributed tracing and centralized logging

_Read at session start. Active phase only; when it is finished, move this section back into `docs/learning/phases.md` (in phase order) and put the next phase here. Previous phase P5 (RabbitMQ): `docs/learning/phases.md` → Phase 5, `docs/progress/messaging.md`._

## Status (branch `p6-tracing`, from `master` `f37747f`)

Plan approved by the owner 2026-11-27 (details, findings, verification: `docs/progress/tracing.md`).

- [ ] **6.0 spike — current.** `src/instrumentation.ts` (`node --import`, off unless `OTEL_TRACES_EXPORTER` is set; sync `module.registerHooks()` via `import-in-the-middle/register-hooks.mjs`) + `src/types/import-in-the-middle.d.ts`; committed on `p6-tracing` (live run still pending). Patching proven offline (pg span, express/http/redis/amqplib wrapped). **Next: owner live run** (API + worker with `OTEL_TRACES_EXPORTER=console`, from the project root) → span names → record in `tracing.md`
- [ ] 6.1 OTel Collector + Tempo in `observability/compose.yml`, Grafana datasource; OTLP exporter; flush on shutdown; drop `process.command_args` from the resource; direct deps `import-in-the-middle@3.5.3`, `@opentelemetry/exporter-trace-otlp-proto@0.300.0` (`npm install` by the owner)
- [ ] 6.2 context through the outbox: `message_outbox.trace_context jsonb NULL` (expand-only migration) written in the POST transaction; relay restores it as parent of publish; consumer extracts; retry copies carry `traceparent`; manual spans (outbox claim, review claim, generation, retry publish)
- [ ] 6.3 `trace_id`/`span_id` in pino (`instrumentation-pino`, correlation only)
- [ ] 6.4 span data safety (no prompts/review text/keys; undici spans of Gemini/Qdrant; noisy fs/dns/net off)
- [ ] 6.5 verification: in-memory exporter test (one `trace_id` POST → outbox → publish → consume; `x-request-id` + `trace_id` in API and worker logs); owner exercises: sampling 100% vs 10% under k6, tail sampling in the collector
- [ ] 6B centralized logs in the owner's local **Elasticsearch/Kibana 9.5.5** (native, not compose): pino → OTLP logs → Collector → `elasticsearch` exporter → `logs-*` data stream; TLS via mounted `http_ca.crt` + `server_name_override: localhost`; least-privilege API key in `observability/.env`; `@custom` mappings, ILM, saved searches, error dashboard. Separate plan after 6.3

Decisions (owner, 2026-11-27): backend **Tempo** (Grafana already present; exemplars; drill in one UI); **OTel Collector** between app and backends; trace context in a new **outbox column** (message contract unchanged); **parent-child** (one trace API → worker incl. retries; span links = production alternative); OTel packages used directly become direct deps; commits after 6.0, 6.1, 6.2, 6.3–6.5; logs backend = local ES/Kibana. Open: dual-export traces to ES as well (assistant recommends, as a 6B exercise).

## Phase plan (moved verbatim from `docs/learning/phases.md`, 2026-11-27)

### Phase 6 — Distributed tracing and centralized logging

**Why OpenTelemetry.** Once a request crosses API → PG/Redis → outbox → RabbitMQ → worker (and later RAG → Qdrant → Gemini), metrics say _that_ it is slow, traces say _where_. OTel is vendor-neutral; packages are already installed but not initialized.

**Why Elasticsearch/Kibana.** Full-text and structured search over logs across all processes, correlated by `requestId`/`trace_id`. Metrics and traces are sampled/aggregated; logs carry the specific error details.

**Prerequisites.** P1 and P5 — owner decision (2026-11-17): tracing and centralized logs start only after RabbitMQ exists; phases are done in order.

**Scope.**

- OTel SDK initialized before app imports (`--import`), auto-instrumentation for http/express/pg/redis; manual spans for outbox claim, cache lookup, RAG stages.
- Context propagation through RabbitMQ message headers (manual inject/extract) — the key learning point.
- OTel Collector → tracing backend (Jaeger or Tempo; choose at phase start). Sampling strategy (head vs tail).
- `trace_id`/`span_id` in pino logs (`@opentelemetry/instrumentation-pino`, already installed).
- Log shipping: stdout → Fluent Bit or OTel Collector → Elasticsearch; index template with explicit mappings (avoid mapping explosion), ILM retention.
- Kibana: Discover saved searches, error dashboard.

**Exercises.**

- Incident drill: alert fires (P1) → Grafana → exemplar/trace → logs in Kibana by `trace_id` → root cause. Write it up as a runbook.
- Measure tracing overhead under load (P2 scenario) with sampling 100% vs 10%.
- Verify no secrets, prompts or document bodies appear in logs/spans.

**Expected outcomes.** One trace spans API → broker → worker; every log line is searchable and correlatable.

**Verification.** Automated check that a request's `x-request-id` and `trace_id` appear in logs of both API and worker; overhead numbers recorded.
