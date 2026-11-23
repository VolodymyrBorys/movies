import { randomUUID } from "node:crypto";
import express from "express";
import { pinoHttp } from "pino-http";
import { logger } from "./infrastructure/logger.ts";
import { metricsMiddleware } from "./infrastructure/metrics.ts";
import { errorHandler } from "./utils/errors.ts";
import { router as moviesRoutes } from "./routes/movies.ts";
import { router as metricsRoutes } from "./routes/metrics.ts";
import { router as healthRoutes } from "./routes/health.ts";
import { router as ragRoutes } from "./routes/rag.ts";
import { router as reviewJobsRoutes } from "./routes/review-jobs.ts";
import helmet from "helmet";

// Probes hit every few seconds per pod; access-logging them only adds noise.
// They are still counted in metrics (own `route` label) and failures are logged in the route.
const PROBE_PATHS = new Set(["/healthz", "/readyz"]);

export const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(
  pinoHttp({
    logger,
    genReqId: () => randomUUID(),
    autoLogging: {
      ignore: (req) => PROBE_PATHS.has((req.url ?? "").split("?")[0] ?? ""),
    },
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customProps(req) {
      return {
        requestId: req.id,
      };
    },
  }),
);

app.use((req, res, next) => {
  res.setHeader("x-request-id", String(req.id));
  next();
});

// Рахуємо запити до парсера, включно з помилками JSON.
app.use(metricsMiddleware);
app.use(healthRoutes);
app.use(express.json({ limit: "1mb" }));
app.use("/v1", metricsRoutes);
app.use("/v1", moviesRoutes);
app.use("/v1", ragRoutes);
app.use("/v1", reviewJobsRoutes);

app.use((_req, res) => {
  res.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: "Route not found",
    },
  });
});

app.use(errorHandler);
