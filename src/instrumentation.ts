import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { register, supportsSyncHooks } from "import-in-the-middle/register-hooks.mjs";

// OpenTelemetry bootstrap (P6). Loaded before the app with `node --import`:
//
//   OTEL_TRACES_EXPORTER=console node --import ./src/instrumentation.ts src/server.ts
//
// Off unless OTEL_TRACES_EXPORTER is set: tests and normal runs never load the SDK.
// Exporter, endpoint, sampler etc. come from the standard OTEL_* env variables (NodeSDK
// reads them). Must not import app modules: everything imported here is loaded before the
// instrumentation hooks are in place and would stay unpatched.
//
// ESM: the app is ESM, so `require`-patching alone doesn't see `import pg from "pg"`; the
// import-in-the-middle loader hook wraps ESM imports for the instrumentations. Registered
// with the synchronous, in-thread `module.registerHooks()` (`module.register()`, which runs
// the loader on a separate thread, is deprecated in Node 26; supported from 26.0.0).
//
// 6.0 spike — open questions: do pg / redis / express / amqplib get patched under ESM +
// native type stripping; are spans flushed on shutdown (process.exit in server/worker).

const exporter = process.env.OTEL_TRACES_EXPORTER;

if (exporter !== undefined && exporter !== "" && exporter !== "none") {
  if (!supportsSyncHooks()) {
    throw new Error(`OpenTelemetry: Node ${process.versions.node} lacks sync loader hooks`);
  }
  register();

  const sdk = new NodeSDK({
    // OTEL_SERVICE_NAME wins if set; otherwise the same name as logs and metrics.
    serviceName: process.env.SERVICE_NAME ?? "movies-api",
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noise: a span per file read / DNS lookup / socket.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
        // Command name only: keys and values (cache payloads) stay out of spans.
        "@opentelemetry/instrumentation-redis": { dbStatementSerializer: (cmdName) => cmdName },
      }),
    ],
  });
  sdk.start();
}
