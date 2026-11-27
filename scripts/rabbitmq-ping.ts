// P5.0 manual check: connect to RabbitMQ with the worker's recovery settings, print the
// broker version, open and close one channel, disconnect. Declares nothing, publishes
// nothing: no state is left on the broker. Needs only RABBITMQ_URL (no PG_*).
//
//   node --env-file-if-exists=.env scripts/rabbitmq-ping.ts
//
// Stop the broker before running to see the startup retries (≈ 15 s, then exit 1).
import pino from "pino";
import {
  rabbitMqConfig,
  RabbitMqNotConfiguredError,
} from "../src/config/rabbitmq.ts";
import { connectRabbitMq } from "../src/infrastructure/rabbitmq.ts";

if (rabbitMqConfig === null) {
  throw new RabbitMqNotConfiguredError();
}

const logger = pino({ base: { service: "rabbitmq-ping" } });

const connection = await connectRabbitMq({
  url: rabbitMqConfig.url,
  connectionName: "movies-rabbitmq-ping",
  logger,
  async setup(model) {
    const { product, version } = model.connection.serverProperties;
    console.log(`connected: ${String(product)} ${String(version)}`);
  },
});

const channel = await connection.createChannel();
channel.on("error", (err: Error) =>
  console.error("channel error:", err.message),
);
await channel.close();
console.log("channel opened and closed");

await connection.close();
console.log("connection closed");
