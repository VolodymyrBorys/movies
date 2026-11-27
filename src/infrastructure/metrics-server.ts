import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import type { Registry } from "prom-client";

// Standalone /metrics endpoint for a process without an API server (the worker, P5.5).
// Plain node:http: one route, no framework needed. The API keeps serving /v1/metrics from
// Express (src/routes/metrics.ts).
//
// LAB: simplified — no auth and listens on all interfaces (Prometheus runs in Docker and
// scrapes host.docker.internal). Production would bind to a private interface or protect it
// with a NetworkPolicy / sidecar.

export interface MetricsServer {
  /** Actual port (useful with port 0 in tests). */
  readonly port: number;
  close(): Promise<void>;
}

export async function startMetricsServer(
  registry: Registry,
  port: number,
  logger: Logger,
): Promise<MetricsServer> {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" || path !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found\n");
      return;
    }
    try {
      const body = await registry.metrics();
      res.writeHead(200, { "Content-Type": registry.contentType }).end(body);
    } catch (error) {
      logger.error({ err: error }, "Metrics collection failed");
      res.writeHead(500, { "Content-Type": "text/plain" }).end("Metrics collection failed\n");
    }
  };

  const server = createServer((req, res) => void handle(req, res));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error); // e.g. EADDRINUSE → startup fails
    server.once("error", onError);
    server.listen(port, () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", (error) => logger.error({ err: error }, "Metrics server error"));

  const address = server.address() as AddressInfo;
  logger.info({ port: address.port }, "Metrics server listening");

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Prometheus keeps scrape connections alive: without this, close() waits for them
        // to time out (up to the force-exit timer).
        server.closeAllConnections();
      }),
  };
}
