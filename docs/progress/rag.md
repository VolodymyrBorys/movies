# RAG — progress

_Last updated: 2026-11-22 (D5) · HEAD at writing: `e311a3a` (`master`) · Code is the source of truth._
_Previous version (2026-11-16, `9c123e0`): core pipeline only, no HTTP. See git history of this file._

## Status

- HTTP layer done (block D, P7; merged into `master`): `POST /v1/knowledge-base/search`, `POST /v1/rag/answer`, `POST /v1/movies/:id/review` (synchronous Gemini review, not persisted).
- Without RAG config the API starts and RAG routes answer **503 `RAG_NOT_CONFIGURED`**.
- **No live Gemini runs** (owner decision, 2026-11-22: billable, frequent 503). Gemini-dependent behavior is implemented as designed and verified **only with mocked clients**. Successful generation has still never been observed (every manual run in 2026-11-16 got `503 UNAVAILABLE`).
- Retrieval was verified manually against real Gemini embed + Qdrant on 2026-11-16 (before the HTTP layer); not re-run since.
- Tests (assistant, 2026-11-22): `npx tsc -p .` exit 0; RAG-related unit tests **166/166** in 13 files (table below). HTTP tests `src/routes/{rag,movie-review}.test.ts` passed (owner, after D2–D4; counts not reported). Integration tests after the merge: reported OK by the owner (2026-11-22; count not reported).

## Architecture

```
HTTP (src/routes/rag.ts, src/routes/movies.ts)
  validate("body" | "params", Zod .strict())          → 400 VALIDATION_ERROR
  └─ controller (rag.controller.ts, movies/movie-review.controller.ts)
       signal = createRequestSignal(res, deadline, shutdownSignal)
       signal.throwIfAborted()                         ← no billable work after abort
       try { service(..., { signal }) } catch → toRagHttpError(error, signal) → errorHandler

POST /v1/knowledge-base/search   (deadline 5 s)
  KnowledgeBaseSearchService.search                     (no LLM; future Agent tool)
    ├─ QdrantSearchService.search
    │    ├─ EmbeddingService.embedQuery   [stage embed,  op retrieval]  Gemini embedContent, 768-dim
    │    └─ qdrantClient.query            [stage search, op retrieval]  technical_documents, Cosine
    └─ ContextBuilderService.build                      (filter → sort → dedup → limit → char budget)
  → { data: { chunks, retrievedChunks, includedChunks } }

POST /v1/rag/answer   (deadline 30 s)
  RagService.answer
    ├─ KnowledgeBaseSearchService.search  (as above)
    ├─ context.text empty → fallback answer, generationSkipped=true, rag_generation_skipped_total++ (Gemini NOT called)
    └─ GeminiGenerationService.generate → generateWithRetries [stage generate, op answer]
  → { data: RagAnswerResult }

POST /v1/movies/:id/review   (deadline 30 s)
  MovieService.getMovieById (primary) → 404 MOVIE_NOT_FOUND
  signal.throwIfAborted()   (deadline may pass during the DB read)
  MovieReviewGenerationService.generate → generateWithRetries [stage generate, op review]
  → { data: { movieId, movieVersion, review, model } }

Indexing (scripts only): document → chunking → embedDocument → QdrantDocumentService (upsert)
```

| File | Responsibility |
|---|---|
| `src/routes/rag.ts`, `src/routes/movies.ts` (`/movies/:id/review`) | Routing + Zod validation; RAG routes always mounted (stable metric labels, 503 instead of 404) |
| `src/modules/rag/rag.controller.ts` | Search/answer handlers; response DTOs `KnowledgeBaseSearchResponse`, `RagAnswerResponse` |
| `src/modules/movies/movie-review.controller.ts` | Review handler; DTO `MovieReviewResponse` |
| `src/modules/rag/validation/{knowledge-base-search,rag-answer}.ts` | Body schemas: `query`/`question` 1–1000 chars (trimmed), `limit` 1–20 |
| `src/modules/rag/rag-deadlines.ts` | `SEARCH_DEADLINE_MS` 5 s, `ANSWER_DEADLINE_MS` / `REVIEW_DEADLINE_MS` 30 s (hypotheses) |
| `src/utils/request-signal.ts` | One `AbortSignal` per request; reasons `RequestDeadlineExceededError` / `ClientDisconnectedError` / `ServerShuttingDownError` |
| `src/infrastructure/shutdown-signal.ts` | Process-wide signal; `abortInFlightRequests()` called in `server.ts` right before `server.close()` |
| `src/modules/rag/rag.errors.ts` | `RagInputError`, `RagUpstreamError{stage, retryable}`, `toUpstreamError`, transient classification |
| `src/modules/rag/rag-http-errors.ts` | `toRagHttpError`: signal reason first, then error type → `AppError` |
| `src/modules/rag/rag-metrics.ts` | `timeStage()`: stage histogram with outcome `ok` / `error` / `cancelled` |
| `src/modules/rag/generation/gemini-generate.ts` | **Single `generateContent` call site**: retry loop, per-attempt timeout, attempt/token metrics, logs |
| `src/modules/rag/generation/gemini-generation.service.ts` | RAG answer prompt (`<context>` block), temperature 0.2, 2048 output tokens |
| `src/modules/rag/generation/movie-review-generation.service.ts` | Review prompt (`<movie>` block), temperature 0.7, 1024 output tokens |
| `src/modules/rag/rag-service.ts`, `knowledge-base-search.service.ts`, `context/`, `embedding/`, `vector-store/` | Core pipeline (unchanged in shape since 2026-11-16; now typed errors + stage timing) |
| `src/config/rag.ts` | Optional RAG config; `RagNotConfiguredError` |
| `src/infrastructure/{gemini,qdrant}/*.client.ts` | Lazy `getGeminiClient()` / `getQdrantClient()`; no `loadEnvFile` |

## Key decisions (why)

### Configuration
- **RAG config is separate from `env.ts`** (`src/config/rag.ts`): `env.ts` requires `PG_*` at import, RAG scripts shouldn't. No RAG variable set → `ragConfig = null`, API starts, clients throw `RagNotConfiguredError` on first use → 503. **Partial config fails fast** (e.g. key without URL is a mistake, not "off"). Error messages contain variable names only, never values.
- Variables: `GEMINI_API_KEY`, `QDRANT_URL` (http/https), optional `QDRANT_API_KEY`, `QDRANT_TIMEOUT_MS` (default 5 s; the Qdrant client's own default is 300 s).
- Clients are lazy, so importing a RAG module (tests, unrelated scripts) doesn't need config. Scripts load `.env` via `node --env-file-if-exists=.env`.

### Cancellation and deadlines
- **One `AbortSignal` per request**, aborted by the first of: deadline, client disconnect (`res` `close` with `!writableFinished`), server shutdown. `abort()` is a no-op once aborted → **first reason wins**. `close` is also the cleanup point (timer + shutdown listener), so handlers need no `dispose()`.
- **The abort reason decides the HTTP status, not the thrown error**: the Gemini SDK aborts with its own controller and surfaces a bare `AbortError`; our reason is only on `signal.reason`. Services rethrow cancellation untouched (`toUpstreamError` leaves it alone when `signal.aborted`).
- **Shutdown aborts in-flight work at `server.close()`, not at `markShuttingDown()`**: requests during the `SHUTDOWN_DELAY_MS` window (readiness already 503) are still served normally.
- Controllers call `signal.throwIfAborted()` before the first billable call; the review handler re-checks after the DB read.
- **Deadlines are hypotheses** (Gemini latency never measured). `ANSWER_DEADLINE_MS` 30 s < one 60 s generation attempt timeout by design: the deadline bounds what the client waits and caps how many retries one request can consume.
- Unchanged from before: Qdrant search is a **soft cancel** (`@qdrant/js-client-rest@1.20` overwrites `init.signal`; the caller is released, the request runs until `QDRANT_TIMEOUT_MS`). Abort is client-side only: Gemini may still bill a request already sent. `// LAB:` production would propagate the remaining deadline upstream.

### Error model
| Failure | Status | Code |
|---|---|---|
| Zod body/params | 400 | `VALIDATION_ERROR` |
| `RagInputError` (service-level guard; normally stopped by Zod) | 400 | `VALIDATION_ERROR` (same code as Zod) |
| signal: deadline | 504 | `DEADLINE_EXCEEDED` (retryable) |
| signal: client disconnected | 499 | `CLIENT_CLOSED_REQUEST` (never seen by the client; keeps logs honest) |
| signal: shutdown | 503 | `SERVICE_SHUTTING_DOWN` (retryable) |
| `RagNotConfiguredError` | 503 | `RAG_NOT_CONFIGURED` |
| `RagUpstreamError`, retryable (429/5xx, network `TypeError`, Qdrant client timeout / resource exhausted, generation attempt timeout) | 503 | `DEPENDENCY_UNAVAILABLE` |
| `RagUpstreamError`, not retryable (4xx, invalid/empty response, invalid payload) | 502 | `DEPENDENCY_FAILED` |
| movie not found (review) | 404 | `MOVIE_NOT_FOUND` |
| anything else | 500 | `INTERNAL_ERROR` |

- Domain errors (`rag.errors.ts`) are **not HTTP-coupled**; the mapping lives in `rag-http-errors.ts`, so the same services can back an Agent tool (P8).
- Client-facing messages are **fixed strings**, never upstream text (may contain response bodies); the original error is kept as `cause` and only logged. Exception: `RagInputError` messages are our own and exposed.
- 502 vs 503: retryable means "try again later" makes sense; 502 says retrying the same request won't help.

### Generation
- **`gemini-generate.ts` is the only `generateContent` call site**, shared by answers and reviews: one retry policy, timeout, cancellation, metrics and log hygiene. The retry loop was moved unchanged: 3 attempts, backoff 1 s·2^n + jitter < 250 ms, retried statuses 429/500/502/503/504, 60 s per-attempt timeout (a timed-out attempt ends the loop as retryable `RagUpstreamError`), no retry after caller cancel, backoff wait cancellable. SDK retries stay off (`httpOptions.retryOptions` not set) → no double retries.
- Review parameters (owner, 2026-11-22): same model as answers (`GENERATION_MODEL`), temperature 0.7, 1024 output tokens, 80–150 words. Movie fields go inside `<movie>…</movie>` and the system instruction marks them as untrusted data.
- Review is allowed for any movie status; it is **not persisted** and every call is billed (`// LAB:`; P5 makes it async: 202 + job, idempotent regeneration, storage). `movieVersion` in the response = the movie's ETag value the review was generated from. No `generatedAt`: API dates come from SQL (microseconds); response time is in the `Date` header.

### Search response
- Returns raw `chunks` (new additive field `BuiltContext.chunks`), not prompt-formatted context text. One client knob, `limit`, sets both retrieval limit and `maxChunks`.

### Metrics (`src/infrastructure/metrics.ts`)
| Metric | Labels | Notes |
|---|---|---|
| `rag_stage_duration_seconds` (histogram, buckets 0.05–60 s) | `stage` (embed/search/generate), `operation` (retrieval/answer/review), `outcome` (ok/error/cancelled) | `generate` includes retries and backoff = what the caller waited. Only existing stage×operation pairs are pre-created |
| `rag_generation_attempts_total` | `operation`, `outcome` (ok/retryable_error/error/timeout/cancelled) | One per `generateContent` call; retries = attempts − requests |
| `rag_tokens_total` | `operation`, `type` (prompt/output/thoughts) | From `usageMetadata`; recorded even for empty answers (billed anyway) |
| `rag_generation_skipped_total` | — | Empty context → no Gemini call |

- `operation` exists so the cost of reviews is visible apart from RAG answers. All series pre-created at 0 (project rule).
- Logs: pino child `component: "gemini-generation"`; attempt/status/SDK message/retry delay only — **never prompts, retrieved bodies or movie data**.

## Bugs found and fixed

- `8e0c876` (2026-11-16) — Qdrant query started even when cancelled during embedding, and a later Qdrant failure became an unhandled rejection (fatal in `server.ts`). Regression tests.
- Block D: no production bugs found after the fact; behavior was proven by mutation checks during development (client getters, abort-reason precedence, `writableFinished`, wrap-after-abort, attempt/token metrics, review `operation` label, tokens per operation, `<movie>` block — all caught, code restored).

## Tests

Unit (Vitest, no network; Gemini/Qdrant clients, `node:timers/promises` replaced with `vi.mock`; logic under test is real). Counts from `npx vitest run src/modules/rag src/config/rag.test.ts src/infrastructure/rag-clients.test.ts src/utils/request-signal.test.ts` (assistant, 2026-11-22):

| File | # | Covers |
|---|---|---|
| `config/rag.test.ts` | 14 | none set → null, partial → fail fast, URL validation, timeout default/coercion, no values in messages |
| `infrastructure/rag-clients.test.ts` | 3 | lazy getters, `RagNotConfiguredError` without config |
| `utils/request-signal.test.ts` | 11 | deadline / disconnect / shutdown reasons, first reason wins, cleanup on `close`, already-aborted shutdown |
| `modules/rag/rag.errors.test.ts` | 20 | status extraction, transient classification, `toUpstreamError` pass-through rules |
| `modules/rag/rag-http-errors.test.ts` | 15 | full mapping table, signal reason over thrown error, fixed messages |
| `modules/rag/rag-metrics.test.ts` | 4 | `timeStage` outcomes incl. cancelled |
| `context/context-builder.service.test.ts` | 11 | empty input/content, sort+dedup, metadata, minScore, maxChunks, char budget, `chunks` output |
| `embedding/embedding.service.test.ts` | 16 | task types, 768 dims, abortSignal, invalid vectors, typed errors, stage timing |
| `vector-store/qdrant-search.service.test.ts` | 24 | request building, validation, mapping, invalid payload, no body logging, cancellation incl. unhandled rejection, typed errors |
| `generation/gemini-generation.service.test.ts` | 25 | retry/backoff/jitter, non-retryable 4xx, timeout, cancellation, attempt/token metrics, no prompt in logs |
| `generation/movie-review-generation.service.test.ts` | 9 | prompt `<movie>` block, params, `operation: "review"`, empty title |
| `knowledge-base-search.service.test.ts` | 5 | pass-through of options/signal, retrievedChunks |
| `rag-service.test.ts` | 9 | empty-context skip (+ skipped metric), sources/metadata, signal forwarding, errors |

HTTP (supertest; need local port binding → run by the owner): `src/routes/rag.test.ts`, `src/routes/movie-review.test.ts` — validation limits, 503 not configured, empty-context fallback, 503 after retries, 504 on deadline (shortened via `rag-deadlines.ts` mock) incl. bare SDK `AbortError`, client disconnect aborts the pipeline, shutdown aborts in-flight with 503; review: 404 without Gemini, 400 non-uuid, DB failure → 500, no generation after a deadline during the DB read, nothing persisted.

- Pitfall (kept): promises returned through `vi.fn()` get handlers attached by Vitest → unhandled rejections are hidden. Return them outside the spy (see `qdrant.respond`).

## Known issues / limitations / TODO

Numbering of the 2026-11-16 list is kept; resolved items are struck through.

1. ~~No overall deadline~~ — **resolved (D1–D4)**: per-request deadline 5 s / 30 s; Qdrant client timeout 5 s (`QDRANT_TIMEOUT_MS`). Remaining: embedding has no timeout of its own (bounded by the caller's signal only — scripts have none); deadlines are unmeasured hypotheses.
2. `minScore` default 0 → weak context still calls Gemini. Needs an eval set to pick a threshold.
3. Chunks are very short (3 chunks ≈ 722 chars of context) — review chunking params.
4. ~~No max length for `question`/`query`~~ — **resolved (D2/D3)**: 1000 chars, `limit` ≤ 20.
5. **Prompt injection via delimiters (→ D6):** retrieved content can contain `</context>`, and movie `title`/`description` can contain `</movie>`, and close the block. Untrusted-data instructions exist in both system prompts, but delimiters are not escaped/neutralized.
6. ~~Plain `Error` everywhere~~ — **resolved (D1)**: `RagInputError`, `RagUpstreamError{stage, retryable}`, HTTP mapping separate.
7. One invalid Qdrant point fails the whole search (`validatePayload` throws → 502).
8. Empty Gemini response is not retried (→ 502); 408 not in retryable statuses (deliberate, revisit if seen).
9. ~~Clients load `.env` themselves; `QDRANT_URL!` unvalidated~~ — **resolved (D0)**. Side effect: RAG scripts that import generation now need `PG_*` again (logger → `env.ts`) and also load `metrics.ts` (`collectDefaultMetrics`); effect on script exit not checked.
10. 768 / collection name duplicated across files (see CLAUDE.md).
11. ~~`console.*` in generation; no RAG metrics~~ — **resolved (D3)**. `console.*` remains only in `qdrant-collection.service.ts` (scripts). Service logs have no `requestId` (no request context until P6).

New (block D):

12. `usageMetadata` field names checked against `@google/genai@3.0.0` types only; its JSDoc says "not supported in Gemini API" → `rag_tokens_total` may stay 0. Verify on the first live run.
13. Aborted requests (499) never reach HTTP metrics (recorded on `finish`); stage metrics do record `cancelled`.
14. No rate limit / per-client token budget on billable endpoints (`// LAB:`). Every answer/review POST is billed; review is not idempotent (no `Idempotency-Key`).
15. Review allowed for any movie status (`draft`/`archived`) — no requirement given; open decision.
16. Response casing is mixed across the API (movies snake_case, RAG/review camelCase) — pre-existing.
17. No alerts or Grafana panels for `rag_*` yet; no SLO for RAG endpoints.
18. `.env.example` should list the RAG variables (owner; the assistant can't read `.env*`).

## Not implemented

- D6: delimiter escaping for `<context>` / `<movie>` + documented threat model (plan first).
- Retrieval quality evaluation (golden set, recall@k / MRR, `minScore`, chunking).
- Async review via RabbitMQ (P5): 202 + job, prefetch as rate limit, DLX on 503, persisted reviews.
- Ingestion via queue with deterministic point IDs (P5).
- Agent tool wrapper for `KnowledgeBaseSearchService` (P8).
- Tests for `qdrant-document.service.ts` / `qdrant-collection.service.ts`; opt-in integration run against real Qdrant/Gemini (billable → approval).
- Tracing spans per stage (P6).
