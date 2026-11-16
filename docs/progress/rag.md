# RAG — progress

_Last updated: 2026-11-16 · HEAD at writing: `9c123e0` · Code is the source of truth._

## Status

- RAG runs only from `scripts/` — there is **no HTTP endpoint** (`app.ts` mounts only `movies` and `metrics`).
- `npm test`: **70/70 passed** (6 files, ~0.3 s, no network). `npx tsc -p .`: exit 0.
- Retrieval verified manually against real Gemini embed + Qdrant (5 retrieved / 3 included, sources intact).
- Successful **generation was never observed**: every manual run got Gemini `503 UNAVAILABLE` (retry worked: 3 attempts, 1 s / 2 s backoff).

## Architecture

```
Indexing:  document → chunking → EmbeddingService.embedDocument → QdrantDocumentService (upsert)
Query:     RagService.answer
             └─ KnowledgeBaseSearchService.search          (no LLM; future Agent tool)
                  ├─ QdrantSearchService.search
                  │    ├─ EmbeddingService.embedQuery      (Gemini embedContent, 768-dim)
                  │    └─ qdrantClient.query               (collection technical_documents, Cosine)
                  └─ ContextBuilderService.build           (filter → sort → dedup → limit → char budget)
             ├─ context.text empty → return fallback answer, generationSkipped=true (Gemini NOT called)
             └─ GeminiGenerationService.generate           (retry/backoff/timeout/cancel)
```

| File (`src/modules/rag/`) | Responsibility |
|---|---|
| `rag-service.ts`, `rag.types.ts` | Full pipeline orchestration; result = answer, model, sources, metadata |
| `knowledge-base-search.service.ts`, `.types.ts` | Retrieval + context building without LLM; passes options/signal through |
| `vector-store/qdrant-search.service.ts` | Validation, query embedding, metadata filters, Qdrant query, payload validation, soft cancel |
| `vector-store/qdrant.types.ts` | Single source of payload/search types |
| `context/context-builder.service.ts`, `context.types.ts` | Pure context building; owns context defaults (5 chunks, minScore 0, 12 000 chars) |
| `embedding/embedding.service.ts` | Gemini embeddings (`gemini-embedding-001`, 768), optional `abortSignal` |
| `generation/gemini-generation.service.ts` | Gemini generation; the only retry layer |
| `src/infrastructure/{gemini,qdrant}/*.client.ts` | Clients; each still loads `.env` itself via `loadEnvFile` |

## Key decisions (why)

- **KnowledgeBaseSearchService has no LLM dependency** — reusable as an Agent tool; RagService only adds generation.
- **Defaults/validation live only in the owning service** (QdrantSearch: limit 5, max 50; ContextBuilder: 5/0/12 000). Upper layers pass options through — avoids drifting duplicated defaults.
- **Retry only in GeminiGenerationService** (3 attempts, 1 s·2^n + jitter < 250 ms, statuses 429/500/502/503/504, 60 s timeout per attempt, timeouts not retried). Verified in `@google/genai@3.0.0`: SDK retries only when `httpOptions.retryOptions` is set; our client doesn't set it → no double retries.
- **Cancellation (`signal`) end to end:** `RagAnswerOptions.signal` → KBS → embedding (hard, client-side) → Qdrant (soft) → generation (hard, no retry after cancel, cancellable backoff).
  - Qdrant is a **soft cancel**: `@qdrant/js-client-rest@1.20` has no per-request signal (its timeout middleware overwrites `init.signal`); caller is released, the HTTP request runs to completion (client timeout 300 s). Acceptable for read-only search.
  - Gemini SDK aborts with its own controller → errors surface as `AbortError`, the caller's `signal.reason` (e.g. `TimeoutError`) is lost. Distinguish cancel vs timeout via `signal.aborted/reason`, not `error.name`.
  - Abort is client-side only: Gemini may still bill a request already sent.
- **Empty context never reaches Gemini**; chunks with empty `content` are dropped (labels alone would make context non-empty).
- **No logging of retrieved document bodies** (removed `console.dir(payload)` from search).

## Bugs found and fixed this stage

- `8e0c876` — Qdrant query started even when cancelled during embedding (`query()` argument evaluated before the signal check), and a later Qdrant failure became an **unhandled rejection** (fatal in `server.ts`). Both covered by regression tests.

## Tests (`src/modules/rag/**/*.test.ts`, Vitest 5)

| File | # | Covers |
|---|---|---|
| `context/context-builder.service.test.ts` | 10 | empty input/content, sort+dedup, metadata, minScore, maxChunks, char budget, option validation |
| `embedding/embedding.service.test.ts` | 9 | task types, 768 dims, abortSignal only when given, invalid/NaN vectors, SDK errors |
| `vector-store/qdrant-search.service.test.ts` | 20 | request building (exactOptional), validation, mapping, invalid payload, no body logging, 6 cancellation cases incl. unhandled rejection |
| `generation/gemini-generation.service.test.ts` | 18 | success, timer cleanup, validation, retry/backoff/jitter, non-retryable 4xx, timeout (fake timers), cancellation incl. "cancel wins over retryable error" |
| `knowledge-base-search.service.test.ts` | 5 | pass-through of options/signal, retrievedChunks, no build on failure |
| `rag-service.test.ts` | 8 | empty-context skip, sources/metadata, signal forwarding, error propagation |

- External I/O replaced via `vi.mock` (clients, `node:timers/promises`); logic under test is real.
- Key tests were **mutation-checked** (temporarily broke the code → the test failed → restored).
- Pitfall: promises returned through `vi.fn()` get handlers attached by Vitest → unhandled rejections are hidden. Return such promises outside the spy (see `qdrant.respond` in the search test).

## Known issues / limitations / TODO

1. No overall deadline for the pipeline; embedding has no timeout of its own (only caller signal); Qdrant relies on the 300 s client default.
2. `minScore` default 0 → weak context still calls Gemini. Needs an eval set to pick a threshold.
3. Chunks are very short (3 chunks ≈ 722 chars of context) — review chunking params.
4. No max length for `question`/`query`.
5. Prompt injection: retrieved content can contain `</context>` and escape the block.
6. Plain `Error` everywhere — no typed domain errors (bad input vs upstream unavailable). `AppError` in `src/utils/errors.ts` is HTTP-coupled.
7. One invalid Qdrant point fails the whole search (`validatePayload` throws).
8. Empty Gemini response is not retried; 408 not in retryable statuses (deliberate, revisit if seen).
9. Gemini/Qdrant clients load `.env` themselves; `QDRANT_URL!` unvalidated. `src/config/env.ts` validates all sections eagerly, so moving clients there first needs a sectioned config (otherwise RAG scripts would require `PG_*`).
10. 768 / collection name duplicated across files (see CLAUDE.md).
11. Logging via `console.*` in generation, not the project logger; no RAG metrics.

## Not implemented

- HTTP endpoints (`/v1/rag/answer`, `/v1/knowledge-base/search`) with Zod validation, request-scoped `signal`, typed errors → 400/503, per-stage metrics.
- Agent tool wrapper for KnowledgeBaseSearchService (tool schema, typed errors).
- Tests for `qdrant-document.service.ts` (upsert) and `qdrant-collection.service.ts`; integration tests with real Qdrant.
- Retrieval quality evaluation (eval set, threshold, chunking).
