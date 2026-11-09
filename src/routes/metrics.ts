import { Router } from "express";
import { metricsRegistry } from "../infrastructure/metrics.ts";

export const router = Router();

router.get("/metrics", async (_req, res, next) => {
  try {
    res.setHeader("Content-Type", metricsRegistry.contentType);

    res.end(await metricsRegistry.metrics());
  } catch (error) {
    next(error);
  }
});
