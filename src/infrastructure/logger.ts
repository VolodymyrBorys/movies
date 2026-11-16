import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import pino from "pino";

const envFile = join(import.meta.dirname, "../../.env");

if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

export const logger = pino({
  level: String(process.env.LOG_LEVEL),
  base: {
    service: "streaming-api",
    environment: "dev",
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
