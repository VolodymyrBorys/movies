import { Agent, request } from "node:http";
import pino from "pino";
import { Counter, Registry } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";
import { startMetricsServer, type MetricsServer } from "./metrics-server.ts";

// Binds a local port (port 0 = any free one): blocked in the assistant sandbox, run by the owner.

const logger = pino({ level: "silent" });
let server: MetricsServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(registry = new Registry()): Promise<MetricsServer> {
  server = await startMetricsServer(registry, 0, logger);
  return server;
}

describe("startMetricsServer", () => {
  it("serves the registry on GET /metrics with the Prometheus content type", async () => {
    const registry = new Registry();
    registry.setDefaultLabels({ service: "movies-worker" });
    new Counter({ name: "test_total", help: "t", registers: [registry] }).inc(3);
    const { port } = await start(registry);

    const response = await fetch(`http://127.0.0.1:${port}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(registry.contentType);
    expect(await response.text()).toContain('test_total{service="movies-worker"} 3');
  });

  it.each([
    ["GET", "/"],
    ["GET", "/v1/metrics"],
    ["POST", "/metrics"],
  ])("answers 404 for %s %s", async (method, path) => {
    const { port } = await start();

    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });

    expect(response.status).toBe(404);
  });

  it("answers 500 when collecting metrics fails", async () => {
    const registry = new Registry();
    registry.metrics = async () => {
      throw new Error("collect failed");
    };
    const { port } = await start(registry);

    expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(500);
  });

  it("close() does not wait for idle keep-alive connections (Prometheus keeps them open)", async () => {
    const { port } = await start();
    // A keep-alive connection left open after the response.
    await new Promise<void>((resolve, reject) => {
      const agent = new Agent({ keepAlive: true });
      const req = request({ port, path: "/metrics", agent }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });

    const startedAt = Date.now();
    await server?.close();
    server = null;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("rejects when the port is taken (startup fails, exit 1)", async () => {
    const { port } = await start();

    await expect(startMetricsServer(new Registry(), port, logger)).rejects.toThrow(/EADDRINUSE/);
  });
});
