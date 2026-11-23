# Target architecture and learning objectives

_Reference, not read at session start. Moved verbatim from `docs/learning-roadmap.md` §2–§3 (2026-11-23). Index: `docs/learning-roadmap.md`._

## 2. Learning objectives

| Area                 | Objective (what "learned" means here)                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Backend architecture | Design a Node.js/TS service with explicit boundaries, typed errors, idempotent handlers, bounded retries, graceful shutdown.  |
| PostgreSQL           | Read query plans, choose indexes, reason about MVCC/locks/isolation, size pools, handle replica lag, run safe migrations.     |
| Redis                | Cache patterns, invalidation, stampede protection, eviction, persistence, replication/failover, failure behavior.             |
| RabbitMQ             | Exchanges/queues, publisher confirms, acks/redelivery, prefetch, DLX, quorum queues, outbox → broker relay.                   |
| AI engineering       | Production RAG (retrieval quality, evals, cost, failure modes), tool-calling agents, MCP, agent evaluation and observability. |
| Observability        | RED/USE metrics, exporters, dashboards, alert rules you can act on, distributed tracing with context propagation.             |
| Logging              | Structured logs, centralized search, correlation by `requestId`/`traceId`, incident investigation workflow.                   |
| Performance          | Reproducible load tests, bottleneck identification, capacity planning backed by numbers.                                      |
| Kubernetes           | Deploy, probe, scale and shut down the service correctly; understand Services, networking, Gateway API, TLS.                  |
| Cloud / IaC          | AWS networking and IAM, Terraform workflows, EKS, managed vs self-hosted trade-offs, CI/CD.                                   |

## 3. Target architecture

Target state after all phases. Components marked `*` do **not** exist yet.

```
                         Internet
                            │ TLS
                 ┌──────────▼──────────┐
                 │ Envoy Gateway*      │  Gateway API: HTTPRoute, TLS, rate limit, canary
                 └──────────┬──────────┘
                            │
        ┌───────────────────▼────────────────────┐         ┌──────────────────────┐
        │ movies-api (Deployment, HPA*)          │         │ Gemini API (external)│
        │  /v1/movies   /v1/rag*  /v1/agent*     │────────▶│ embed / generate     │
        │  /v1/metrics  /healthz  /readyz        │         └──────────────────────┘
        └───┬────────────┬───────────┬───────────┘
            │            │           │
   ┌────────▼───┐  ┌─────▼────┐  ┌───▼──────┐
   │ PostgreSQL │  │ Redis    │  │ Qdrant   │
   │ primary +  │  │ cache    │  │ vectors  │
   │ replica    │  │ (+repl*) │  └──────────┘
   │ + outbox   │  └──────────┘
   └────┬───────┘
        │ outbox relay* (SKIP LOCKED, lease)
   ┌────▼────────┐      ┌─────────────────────────────────────────┐
   │ RabbitMQ*   │─────▶│ workers* (Deployment, separate process) │
   │ exchanges,  │      │  cache invalidation, document ingestion │
   │ DLX, quorum │      │  (embedding is slow/billable → queued)  │
   └─────────────┘      └─────────────────────────────────────────┘

 Observability plane:
   Prometheus + exporters (postgres, redis; rabbitmq*) → Grafana dashboards, Alertmanager rules
     (local compose in observability/, since 2026-11-17)
   OpenTelemetry SDK* → OTel Collector* → tracing backend* (Jaeger or Tempo, decided in Phase 6)
   pino JSON stdout → log shipper* (Fluent Bit or OTel Collector) → Elasticsearch* → Kibana*

 Platform plane:
   Docker images* → Kubernetes (kind/k3d locally*, EKS later*) ← Terraform* (VPC, IAM, EKS, RDS?, ElastiCache?)
   CI/CD*: typecheck, tests, image build/scan, plan/deploy
```

Design constraints for the target:

- **One API service + one worker service.** No microservice split of the domain; the lab is about infrastructure mechanisms, not service decomposition.
- **PostgreSQL stays the source of truth.** Redis is cache only; RabbitMQ is transport, not storage. The outbox remains the atomicity mechanism — RabbitMQ does not replace it.
- **Application writes logs to stdout only.** Shipping is the platform's job (12-factor).
- **Managed vs self-hosted** is a deliberate comparison in Phase 11, not a default.
