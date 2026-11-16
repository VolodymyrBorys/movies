import { randomUUID } from "node:crypto";
import { createClient, RedisClient, type RedisClientOptions } from "redis";
import { config } from "../config/env.ts";
import { logger as rootLogger } from "./logger.ts";

const logger = rootLogger.child({ component: "redis" });

export const REDIS_OPTIONS: RedisClientOptions = {
  url: config.redis.url,
  // Spread instead of `username: undefined` because of exactOptionalPropertyTypes.
  ...(config.redis.username !== undefined
    ? { username: config.redis.username }
    : {}),
  ...(config.redis.password !== undefined
    ? { password: config.redis.password }
    : {}),
  // commandsQueueMaxLength: 1000,
  pingInterval: 30_000,
  commandOptions: {
    timeout: 1000, // означає, що команда може чекати до секунди — для кешу це може бути надто довго, особливо якщо endpoint має жорсткий latency budget.
  },
  disableOfflineQueue: true, // true не дозволяє накопичувати команди, коли клієнт не підключений. Це допомагає не відкладати кеш-операції на невизначений час
  socket: {
    keepAlive: true,
    // cert
    keepAliveInitialDelay: 10_000,
    // tls
    // timeout
    connectTimeout: 3000,
    reconnectStrategy: (retries: number) => {
      // Generate a random jitter between 0 – 100 ms:
      const jitter = Math.floor(Math.random() * 100);
      // Delay is an exponential backoff, (2^retries) * 50 ms, with a
      // maximum value of 3000 ms:
      const delay = Math.min(Math.pow(2, retries) * 50, 3000);
      return delay + jitter;
    },
  },
};

class RedisService {
  client!: ReturnType<typeof createClient>;
  //   private publisher!: ReturnType<typeof createClient>;
  //   private subscriber!: ReturnType<typeof createClient>;

  async start(options: RedisClientOptions = REDIS_OPTIONS) {
    this.client = createClient(options);
    // Emitted on every failed reconnect attempt as well, so expect repeats during an outage.
    this.client.on("error", (err: unknown) => {
      logger.error({ err }, "Redis client error");
    });
    this.client.on("connect", () => {
      logger.info("Redis connecting");
    });
    this.client.on("ready", () => {
      logger.info("Redis ready");
    });
    this.client.on("reconnecting", () => {
      logger.warn("Redis reconnecting");
    });

    this.client.on("end", () => {
      logger.info("Redis connection closed");
    });

    await this.client.connect();
    const pong = await this.client.ping();
    if (pong === "PONG") logger.info("Redis connected");
    else throw new Error("Redis is unavailable");
  }

  async destroy() {
    // if (this.subscriber.isOpen) await this.subscriber.quit();
    // if (this.publisher.isOpen) await this.publisher.quit();
    if (this.client.isOpen) await this.client.quit();
    logger.info("Redis connections closed");
  }

  /** Readiness check. With disableOfflineQueue it fails fast while disconnected. */
  async ping(): Promise<void> {
    const pong = await this.client.ping();
    if (pong !== "PONG") throw new Error(`Unexpected PING reply: ${pong}`);
  }

  async get(key: string) {
    const result = await this.client.get(key);
    if (result === null) return null;
    return JSON.parse(result);
  }

  async set(body: any, key: string, ttl: number) {
    await this.client.set(key, JSON.stringify(body), {
      expiration: { type: "EX", value: ttl },
    });
  }

  async getMoviesListVersion(): Promise<string> {
    const key = "movies:list:version";

    let value = await this.client.get(key);

    if (value !== null) {
      return value;
    }

    // SET NX: лише один конкурентний запит ініціалізує ключ.
    await this.client.set(key, randomUUID(), { NX: true });

    value = await this.client.get(key);

    if (value === null) {
      throw new Error("Failed to initialize movies:list:version");
    }

    return value;
  }

  async invalidateMoviesList(): Promise<string> {
    const version = randomUUID();
    await this.client.set("movies:list:version", version);
    return version;
  }
}

export const REDIS = new RedisService();
