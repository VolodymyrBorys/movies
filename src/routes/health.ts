import { Router } from "express";
import { PG } from "../infrastructure/postgres.ts";
import { REDIS } from "../infrastructure/redis.ts";
import { logger } from "../infrastructure/logger.ts";
import { checkReadiness, isShuttingDown } from "../infrastructure/health.ts";

// Probe endpoints are mounted at the root, not under /v1: they are an operational
// contract with the platform (Kubernetes, load balancer), not part of the versioned API.
export const router = Router();

// Typical probe timeoutSeconds is 1 s; answer before the prober gives up.
const READINESS_CHECK_TIMEOUT_MS = 800;

router.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ status: "ok" });
});

router.get("/readyz", async (_req, res, next) => {
  try {
    const result = await checkReadiness({
      pingPostgresWrite: () => PG.ping("write"),
      pingPostgresRead: () => PG.ping("read"),
      pingRedis: () => REDIS.ping(),
      isShuttingDown,
      timeoutMs: READINESS_CHECK_TIMEOUT_MS,
      onCheckFailed: (dependency, err) => {
        logger.warn({ err, dependency }, "Readiness check failed");
      },
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(result.ready ? 200 : 503).json({
      status: result.ready ? "ready" : "not_ready",
      shuttingDown: result.shuttingDown,
      checks: result.checks,
    });
  } catch (error) {
    next(error);
  }
});
