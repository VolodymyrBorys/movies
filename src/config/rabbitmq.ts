import { z } from "zod";

// RabbitMQ config (P5), separate from env.ts like rag.ts: optional section, and the API
// process never connects to the broker (the outbox relay and consumers live in the worker
// process). Like env.ts, this module does NOT load `.env`: use `node --env-file-if-exists=.env`.
//
// RABBITMQ_URL unset → rabbitMqConfig === null ("not configured"); an invalid value fails
// fast. The URL may carry credentials (amqp://user:pass@host): never log it.

const amqpUrl = z.string().refine(
  (value) => {
    try {
      const { protocol, hostname } = new URL(value);
      return (protocol === "amqp:" || protocol === "amqps:") && hostname.length > 0;
    } catch {
      return false;
    }
  },
  { message: "must be an amqp:// or amqps:// URL with a host" },
);

const RabbitMqEnvSchema = z.object({
  RABBITMQ_URL: amqpUrl,
});

export interface RabbitMqConfig {
  readonly url: string;
}

export class RabbitMqNotConfiguredError extends Error {
  constructor() {
    super("RabbitMQ is not configured: set RABBITMQ_URL");
    this.name = "RabbitMqNotConfiguredError";
  }
}

/** Returns null when RABBITMQ_URL is unset; throws when it is invalid. */
export function loadRabbitMqConfig(source: NodeJS.ProcessEnv): RabbitMqConfig | null {
  if (source.RABBITMQ_URL === undefined) {
    return null;
  }

  const result = RabbitMqEnvSchema.safeParse(source);

  if (!result.success) {
    // Variable names and messages only: the URL may contain a password.
    const details = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid RabbitMQ configuration: ${details}`);
  }

  return Object.freeze({ url: result.data.RABBITMQ_URL });
}

export const rabbitMqConfig: RabbitMqConfig | null = loadRabbitMqConfig(process.env);
