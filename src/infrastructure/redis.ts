import { randomUUID } from "node:crypto";
import { createClient, RedisClient, type RedisClientOptions } from "redis";

const REDIS_URL = "redis://localhost:6379";

export const REDIS_OPTIONS: RedisClientOptions = {
  url: REDIS_URL,
  username: "redis",
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
    this.client.on("error", (err: any) => {
      console.error("❌ Redis Client Error:", err);
    });
    this.client.on("connect", () => {
      console.log("[REDIS] connecting...");
    });
    this.client.on("ready", () => {
      console.log("[REDIS] ready");
    });
    this.client.on("reconnecting", () => {
      console.log("[REDIS] reconnecting");
    });

    this.client.on("end", () => {
      console.log("[REDIS] connection closed");
    });

    await this.client.connect();
    const pong = await this.client.ping();
    if (pong === "PONG") console.log("✅ Redis connected");
    else throw new Error("Redis is unavailable");
  }

  async destroy() {
    // if (this.subscriber.isOpen) await this.subscriber.quit();
    // if (this.publisher.isOpen) await this.publisher.quit();
    if (this.client.isOpen) await this.client.quit();
    console.log("🧹 Redis connections closed");
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
