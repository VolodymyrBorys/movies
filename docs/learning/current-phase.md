# Current phase: P6 — Distributed tracing and centralized logging

_Read at session start. Active phase only; when it is finished, move this section back into `docs/learning/phases.md` (in phase order) and put the next phase here. Previous phase P5 (RabbitMQ): `docs/learning/phases.md` → Phase 5, `docs/progress/messaging.md`._

## Status

Chosen by the owner 2026-11-27 after closing P5. **Not started: no plan yet.** Per the working agreement (`docs/learning-roadmap.md` §7) the phase starts with a plan for approval: re-check what exists (OpenTelemetry packages installed, never initialized; pino logger with `requestId`; API and worker are separate processes), choose the tracing backend (Jaeger or Tempo) and the log pipeline, list required approvals (dependencies, compose services, config).

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
