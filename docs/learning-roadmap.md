# Learning Roadmap — Movies Production-Engineering Lab

_Created: 2026-11-16 · Restructured: 2026-11-23 (index only; full pre-restructure copy: `docs/sessions/archive/learning-roadmap-2026-11-23.md`)._
_Code is the source of truth. Phase plans are **plans**, not a description of what exists._

**Current phase: P6 (tracing + centralized logging, not started) — details in `docs/learning/current-phase.md`.** Order decided by the owner (2026-11-19): **C** (P3 CRUD + optimistic concurrency, done early) → **D** (P7 RAG endpoints + sync review, done) → **B** (P2 k6 baseline, partly done, rest deferred) → **P5** (done 2026-11-27) → **P6** (owner, 2026-11-27). **No live Gemini runs** (owner, 2026-11-22): Gemini-dependent behavior is verified with mocks only.

## Where things live

| File | Content | Read at session start |
| --- | --- | --- |
| `docs/learning-roadmap.md` | This index: vision, phase status, dependency graph, working agreement | yes |
| `docs/learning/current-phase.md` | Active phase: plan, decisions, step checklist | yes |
| `docs/session-log.md` | Checkpoint of the last session (rewritten on each save) | yes |
| `docs/learning/phases.md` | Plans + status notes of all other phases | no |
| `docs/learning/implementation-status.md` | Implemented / gaps / missing; testing strategy | no |
| `docs/learning/target-architecture.md` | Learning objectives, target architecture | no |
| `docs/progress/<topic>.md` | Technical source of truth per topic (`messaging`, `rag`, `postgres`, `observability`); perf: `docs/perf/baseline.md` | when the task needs it |
| `docs/sessions/archive/` | Past session logs, roadmap snapshot | no (history only) |

## 1. Vision

This repository is a **production-engineering learning lab**, not just a Movies API. The Movies API is a deliberately small domain that gives every infrastructure component a real job: reads to cache, writes to invalidate, events to deliver, documents to search, requests to trace.

The goal is to evolve it **incrementally** into a production-like system and, at every step, understand the mechanism well enough to operate and debug it:

- every component is introduced because the system **needs** it (a concrete use case), not because it is on this list;
- every phase ends with **measured or tested evidence** (test, `EXPLAIN ANALYZE`, load test, dashboard, alert fired and resolved);
- simplifications are marked in code (`// LAB: simplified — production would also ...`) and in phase notes.

## Phase status

Order and scope unchanged; details in `docs/learning/phases.md` (P6: `docs/learning/current-phase.md`). ✅ done · ◐ partly done / in progress · ⏳ not started · ⏸ deferred by the owner.

| Phase | Status | Open / deferred |
| --- | --- | --- |
| P0 Foundation and reproducibility | ◐ mostly done | ⏸ compose for app deps; optional CI |
| P1 Metrics, dashboards, alerting | ◐ in progress | ⏸ drills 2–3, replica-lag alert (replica decision first), watchdog, inhibition rules |
| P2 Load testing and baseline | ◐ P2.0 smoke passed, P2.1 cached 100–1600 req/s green | ⏸ cached 3200+, P2.2 cold, P2.3–P2.8 |
| P3 PostgreSQL internals | ◐ block C done early (CRUD, ETag/If-Match, expand/contract NOT NULL) | rest of the phase not started |
| P4 Redis | ⏳ | — |
| P5 RabbitMQ and workers | ✅ done 2026-11-27 (PR #1): outbox relay, review consumer, retry/DLQ, metrics/alerts/dashboard, graceful shutdown; `docs/progress/messaging.md` | ⏸ live drills (P5.4 live run, 5.5f, P5.6 SIGTERM) and P5.7 exercises not run; P5.4b reconciliation proposed |
| **P6 Tracing and centralized logging** | ◐ **current** (2026-11-27), not started | next: plan for approval (backend, log pipeline, approvals) |
| P7 RAG in production | ◐ D0–D6 done (endpoints, errors, deadlines, metrics, delimiters) | retrieval eval, ingestion via queue, cost controls |
| P8 Agents / MCP / evals | ⏳ | — |
| P9 Containers and Kubernetes | ⏳ | — |
| P10 Gateway API / Envoy / TLS | ⏳ | — |
| P11 AWS / Terraform / EKS / CD | ⏳ | — |

## Phase order

Order is chosen so each phase produces the **measurement tools or infrastructure the next one needs**. Each phase lists: why, prerequisites, scope, exercises, expected outcomes, verification. Any new dependency, schema change or infra file in a phase still requires explicit approval when the phase starts (see `CLAUDE.md`).

### Dependency graph

```
P0 Foundation ──┬─▶ P1 Metrics/Alerts ──┬─▶ P2 Load testing ──┬─▶ P3 PostgreSQL
                │                       │                     ├─▶ P4 Redis
                │                       │                     └─▶ P5 RabbitMQ ──▶ P6 Tracing + Logs
                │                       │
                │                       └─▶ P7 RAG in production ──▶ P8 Agents / MCP / Evals
                │                                (P6 recommended before P8)
                └─▶ P9 Containers + Kubernetes ──▶ P10 Gateway API / Envoy / TLS ──▶ P11 AWS / Terraform / EKS / CD
                       (needs P0 health endpoints, P1 metrics; P5 for worker split)
```

Tracks after P2 can interleave: **backend** (P3–P6), **AI** (P7–P8), **platform** (P9–P11). Basic CI (typecheck + tests) can be added at any time from P0.

## 7. Working agreement per phase

1. Start: re-check this document's status against code; list required approvals (dependencies, schema, infra, CI).
2. Implement one mechanism at a time; mark simplifications with `// LAB:`.
3. Prove it (test, plan, load test, alert drill).
4. Finish: write `docs/progress/<topic>.md` (format as in `docs/progress/rag.md`), update `docs/learning/implementation-status.md`, the phase status table above and the "Current state" in `CLAUDE.md`.
