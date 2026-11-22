// Total time budget per request, from arrival to response (all stages + retries).
// HYPOTHESES, not measurements: Gemini latency was never observed (live runs are off,
// see CLAUDE.md). Revisit with real numbers. Own module so HTTP tests can shorten them.
//
// Search = embed (Gemini) + Qdrant query; should be well under a second when healthy.
export const SEARCH_DEADLINE_MS = 5_000;
