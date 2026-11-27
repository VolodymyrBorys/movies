# Session checkpoint

Last session only; rewritten on each save. Previous checkpoints: `docs/sessions/archive/` (history, not read at session start).
"owner" = verified by the repository owner outside the assistant sandbox. Plan: `docs/learning-roadmap.md`, active phase: `docs/learning/current-phase.md`; per-topic details: `docs/progress/`.

## 2026-11-27 (session 5, end) · P5.4–P5.6 committed + merged, P5 closed, P6 plan + 6.0 spike

Branch `p6-tracing` (from `master` `f37747f`; no upstream yet: sandbox can't write `.git/config` → set on the owner's first `git push -u`). Last commit: 6.0 spike (`src/instrumentation.ts`, `src/types/import-in-the-middle.d.ts`) + docs of this save + `CLAUDE.md` (OTel line), committed before the live run (owner's call).
Commits this session: `77f976d` P5.4, `d460ca0` P5.5a–b, `30d4838` P5.5c–e, `a39dd56` docs (mid-session checkpoint, archived), `7f51ae6` P5.6, `0f7f232` P5.8; merged by the owner: PR #1 `32f2b53` (p5-rabbitmq), PR #2 `f37747f` (p5-wrap-up).

### Completed
- P5.4 review fixes + P5.5 (details: archived mid-session checkpoint, `docs/progress/messaging.md`).
- P5.6 graceful shutdown: consumer drain (cancel → 25 s → abort → `releaseForShutdown` with attempt refund → requeue), outcome `shutdown_released`, force exit 40 s.
- P5.8: summary in `docs/progress/messaging.md`; P5 closed and moved to `docs/learning/phases.md`; P6 current.
- P6 plan approved; 6.0 spike: OTel bootstrap via sync `module.registerHooks()` (`docs/progress/tracing.md`).

### Decisions (owner, 2026-11-27)
- P5.5f drills, P5.6 live exercise, P5.7 exercises skipped → recorded as unverified / open items (not done).
- P5.6: drain timeout constant 25 s; shutdown-aborted attempt refunded; message requeued (no retry tier).
- P5 closed with P5.4b + P5.7 as open items; next phase P6.
- P6: Tempo, OTel Collector, `message_outbox.trace_context` column, parent-child traces, OTel packages as direct deps, commits after 6.0 / 6.1 / 6.2 / 6.3–6.5; logs → owner's local ES/Kibana 9.5.5 (6B).
- `module.register()` replaced by `module.registerHooks()` (deprecated in Node 26; noticed by the owner).

### Verification
- Assistant: `npx tsc -p .` 0; unit 418/418 (excl. `src/routes`, `metrics-server.test.ts`); P5.6 9 mutation checks caught; 6.0 offline probes: pg span emitted, express / `http.Server.emit` / redis / amqplib methods wrapped.
- Owner: `npm run test:integration` green after P5.6 (incl. `releaseForShutdown`); ES 9.5.5 cluster `green`.
- Owner spike runs: run 1 only startup spans (no HTTP spans; requests likely went to another process); run 2 failed (`ERR_MODULE_NOT_FOUND`, started from the Kibana dir).
- Not verified: HTTP/express/amqplib spans live; span flush on shutdown; P5 live drills (P5.4 live run, 5.5f alerts/dashboard, P5.6 SIGTERM); P5.7.

### Known issues
- Spike live run pending (above). `register()` hooks every module (overhead not measured). `process.command_args` in the OTel resource (drop in 6.1).
- `import-in-the-middle` imported directly but still transitive → `npm install import-in-the-middle@3.5.3 @opentelemetry/exporter-trace-otlp-proto@0.300.0` (owner, 6.1).
- Owner's `es-start` / `kibana-start` aliases `cd` the shell away; fix with `( … )` subshells; quote `?` URLs in zsh.
- Remote branch `p5-rabbitmq` deletion and GitHub "auto-delete head branches" not confirmed; local branches `p5-rabbitmq`, `p5-wrap-up`, stale local `master`.
- Carried over (P5 open items, `messaging.md` → Summary → Open items): P5.4b reconciliation, P5.7 exercises, re-queue P5.3 dead-lettered outbox rows, double Gemini retry layers, `message_outbox` retention, `retryDelayMs` cap 256 s, `ReviewQueueBacklog` threshold guess, `FOR UPDATE` int-test mutation not reported. Older: stale `[branch "p2-k6-baseline"]` in `.git/config`; remote `p2-k6-baseline` / `p7-prompt-delimiters` deletion unconfirmed; P5.1 up → down → up not reported; no mutation check of review `ON CONFLICT`; possible `shutdown()` bug under `npm run dev --watch`.

### Next steps
1. Owner: spike live run from the project root (commands: `docs/progress/tracing.md` → 6.0 → Live run); "done" → assistant reads span names from `/tmp/otel-*.log`.
2. Owner pushes `p6-tracing` with `-u`; after the live run, record span names in `tracing.md` (and fix the bootstrap if spans are missing).
3. Owner answers: dual-export traces to ES too? Then 6.1 (Collector + Tempo, OTLP, flush, resource, direct deps).
