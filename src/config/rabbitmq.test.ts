import { describe, expect, it } from "vitest";
import { loadRabbitMqConfig } from "./rabbitmq.ts";

describe("loadRabbitMqConfig", () => {
  it("returns null when RABBITMQ_URL is unset", () => {
    expect(loadRabbitMqConfig({})).toBeNull();
  });

  it.each(["amqp://localhost:5672", "amqps://user:pass@mq.internal:5671/vhost"])(
    "accepts %s and returns a frozen config",
    (url) => {
      const config = loadRabbitMqConfig({ RABBITMQ_URL: url });

      expect(config).toEqual({ url });
      expect(Object.isFrozen(config)).toBe(true);
    },
  );

  it.each([
    ["empty", ""],
    ["not a URL", "localhost:5672"],
    ["wrong protocol", "http://localhost:15672"],
    ["no host", "amqp://"],
  ])("fails fast on an invalid URL (%s)", (_case, url) => {
    expect(() => loadRabbitMqConfig({ RABBITMQ_URL: url })).toThrow(
      /Invalid RabbitMQ configuration: RABBITMQ_URL/,
    );
  });

  it("never puts the URL (and its password) into the error", () => {
    const url = "http://user:top-secret@localhost:5672";

    expect(() => loadRabbitMqConfig({ RABBITMQ_URL: url })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("top-secret") }),
    );
  });
});
