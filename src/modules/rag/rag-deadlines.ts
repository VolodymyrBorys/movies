// Total time budget per request, from arrival to response (all stages + retries).
// HYPOTHESES, not measurements: Gemini latency was never observed (live runs are off,
// see CLAUDE.md). Revisit with real numbers. Own module so HTTP tests can shorten them.
//
// Search = embed (Gemini) + Qdrant query; should be well under a second when healthy.
export const SEARCH_DEADLINE_MS = 5_000;

// Answer = search + generate (up to 3 attempts with 1 s / 2 s backoff). Shorter than one
// 60 s generation attempt timeout on purpose: the deadline, not the per-attempt timeout,
// bounds what the client waits; it also caps how much retrying a single request can do.
export const ANSWER_DEADLINE_MS = 30_000;
