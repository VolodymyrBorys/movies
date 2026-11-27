# Tracing and centralized logging (P6) — progress

_Started 2026-11-27 · branch `p6-tracing` (from `master` `f37747f`) · Code is the source of truth. Plan, step checklist and owner decisions: `docs/learning/current-phase.md`._

## Status

| Step | State |
|---|---|
| 6.0 spike: SDK bootstrap, does ESM patching work | in progress: patching proven offline (assistant); live run with API + worker pending (owner); committed on `p6-tracing` |
| 6.1–6.5, 6B | not started (see `current-phase.md`) |

## 6.0 — SDK bootstrap (spike)

| File | Role |
|---|---|
| `src/instrumentation.ts` | Loaded with `node --import ./src/instrumentation.ts` before the app. Off unless `OTEL_TRACES_EXPORTER` is set (and not `none`): tests and normal runs never load the SDK. `NodeSDK` + `getNodeAutoInstrumentations` (fs / dns / net off; redis `dbStatementSerializer` = command name only, so keys and cached values stay out of spans). `serviceName` = `SERVICE_NAME` (default `movies-api`); exporter, sampler, endpoint via standard `OTEL_*` env. Imports no app module (anything imported here loads before the hooks and stays unpatched). npm scripts unchanged. |
| `src/types/import-in-the-middle.d.ts` | Ambient types for `import-in-the-middle/register-hooks.mjs`: the package ships `register-hooks.d.ts`, TypeScript looks for `.d.mts` for an `.mjs` subpath (TS7016 otherwise). Mirrors the shipped declaration (3.5.x). |

### Decisions

- **ESM needs a loader hook.** The app is ESM (`"type": "module"`, native type stripping); `require`-patching (require-in-the-middle) alone doesn't see `import pg from "pg"`. import-in-the-middle wraps ESM module namespaces for the instrumentations.
- **`module.registerHooks()` (sync, in-thread) instead of `module.register("@opentelemetry/instrumentation/hook.mjs")`.** `module.register()` is deprecated in Node 26 (owner noticed the `@deprecated` hint); it also runs the loader on a separate thread with an IPC round-trip per module. `import-in-the-middle/register-hooks.mjs` → `register()`; needs Node ≥ 26.0.0 / 25.1 / 24.11.1 / 22.22.3 (`supportsSyncHooks()`, startup throws otherwise). Runtime: Node v26.13.1. `register()` without `include` hooks every module (cost not measured; an `include` list of instrumented packages is the option if startup/overhead matters).
- **Supported versions** (instrumentation READMEs, checked 2026-11-27): amqplib `>=0.5.5 <3` (we use 2.4.1), pg `<9`, redis `<7`, express `<6`, pino `<11`, undici `>=5.12`. Installed: `sdk-node` / `instrumentation` 0.300.0, `instrumentation-amqplib` 0.71.0, `import-in-the-middle` 3.5.3 (single copy).
- **amqplib 2.x has an `exports` map** (only `.` and `./callback_api`), but the instrumentation patches the internal `lib/channel_model.js`, `lib/callback_model.js`, `lib/connect.js` — reached through `require()` inside the CJS package, so patching works (probe below).

### Findings

- `process.command_args` is a default resource attribute: the whole command line ends up in every span batch — a secret passed as a CLI argument would leak. Drop it in 6.1 (resource detector config).
- `import * as http from "node:http"`: the namespace binding `http.request` is not wrapped, the default export's is; incoming requests are traced through `http.Server.prototype.emit` (wrapped). Outgoing calls via a named `request` import would be missed — we use `fetch`/undici.
- pg span names follow the newer semconv: `pg.query:SELECT <db name>`.

### Verification

- Assistant (2026-11-27): `npx tsc -p .` 0; unit 418/418 (excl. `src/routes`, `metrics-server.test.ts`). Offline probes with `OTEL_TRACES_EXPORTER=console node --import ./src/instrumentation.ts`: with `module.register()` — a `pg.connect` span (EPERM, sandbox) under a manual root span; with `registerHooks` — `pg.Client.prototype.query`, express `Router.route`, `http.Server.prototype.emit`, `ConfirmChannel.prototype.publish` (also `Channel.publish/consume/ack`, `connect`) and a node-redis client method all `__wrapped`. Wrapped ≠ spans emitted.
- Owner run 1 (`module.register()` version): only startup spans (`pg-pool.connect`, `pg.connect`, `pg.query:SELECT …`, `redis-connect`, `redis-PING`), `trace_id` present in pino logs; no HTTP spans — requests most likely not sent to this process. Run 2: started from the Kibana directory (an alias had `cd`'d there) → `ERR_MODULE_NOT_FOUND`; the `202` came from another server on :3000.
- Not verified: HTTP/express spans for real requests; amqplib publish/consume spans with amqplib's recovering connection; span flush on shutdown (`process.exit` in `server.ts`/`worker.ts`; console exporter is synchronous, OTLP batching in 6.1 is not).

Live run (owner), from the project root, after stopping anything on :3000:
```
OTEL_TRACES_EXPORTER=console node --env-file-if-exists=.env --import ./src/instrumentation.ts src/server.ts > /tmp/otel-api.log 2>&1
SERVICE_NAME=movies-worker OTEL_TRACES_EXPORTER=console node --env-file-if-exists=.env --import ./src/instrumentation.ts src/worker.ts > /tmp/otel-worker.log 2>&1
curl -s 'localhost:3000/v1/movies?limit=1' >/dev/null
curl -si -X POST localhost:3000/v1/movies/<id>/review
# ~15 s, Ctrl+C both; expected: GET /v1/movies, POST …/review, express spans, pg.query:INSERT,
# amqplib send/process spans in the worker (separate traces until 6.2)
```

## 6B — local Elasticsearch / Kibana (design notes, not started)

Owner's local install (not compose): Elasticsearch 9.5.5 (single node, `green`, TLS with `$ES_HOME/config/certs/http_ca.crt`, user `elastic`), Kibana 9.5.5. Shell aliases start them (`es-start`, `kibana-start`); a `cd` in an alias leaves the shell there — wrap in a subshell `( … )`; quote URLs with `?` in zsh.
Intended path: pino → OTLP logs → Collector (docker) → `elasticsearch` exporter → `https://host.docker.internal:9200`. TLS: mount the CA, `server_name_override: localhost` (certificate most likely issued for `localhost`; no `insecure_skip_verify`). Auth: API key limited to writing `logs-*` (`traces-*` if dual export), created by the owner, stored in `observability/.env` (never read by the assistant). ES 9 ships templates for OTel data → customise via `@custom` component templates + ILM. Production alternative: stdout → node agent (`filelog` / Fluent Bit), shown in P9.
