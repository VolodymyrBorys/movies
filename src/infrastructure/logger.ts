import pino from "pino";
import { config } from "../config/env.ts";

// `.env` is loaded by `node --env-file-if-exists=.env` (npm run dev); see src/config/env.ts.
export const logger = pino({
  level: config.log.level,
  base: {
    service: "movies-api",
    environment: config.nodeEnv,
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-api-key",
      "res.headers.set-cookie",
    ],
    censor: "[REDACTED]",
  },
});
