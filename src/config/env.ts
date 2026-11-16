import { z } from "zod";

// Single place that reads process.env. The rest of the app imports `config`.
// Loading `.env` is NOT done here: in development `node --env-file-if-exists=.env`
// fills process.env; in production the platform injects variables.
//
// LAB: simplified — production would often also support `*_PASSWORD_FILE`
// (Docker/K8s secrets mounted as files) so secrets don't live in the process env.

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();
const nonEmpty = z.string().min(1);

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    PG_DATABASE: nonEmpty,
    PG_PRIMARY_HOST: nonEmpty,
    PG_PRIMARY_PORT: port.default(5432),
    PG_PRIMARY_USER: z.string().optional(),
    PG_PRIMARY_PASSWORD: z.string().optional(),

    // Optional replica: set all of HOST/USER/PASSWORD or none.
    PG_REPLICA_HOST: nonEmpty.optional(),
    PG_REPLICA_PORT: port.default(5432),
    PG_REPLICA_USER: z.string().optional(),
    PG_REPLICA_PASSWORD: z.string().optional(),

    // Tuning defaults match the previous hardcoded values.
    PG_POOL_MAX: positiveInt.default(10),
    PG_STATEMENT_TIMEOUT_MS: positiveInt.default(2_000),
    PG_CONNECT_TIMEOUT_MS: positiveInt.default(5_000),
    PG_SSL: z.enum(["disable", "verify-full"]).default("disable"),
  })
  .superRefine((env, ctx) => {
    const replica = [
      env.PG_REPLICA_HOST,
      env.PG_REPLICA_USER,
      env.PG_REPLICA_PASSWORD,
    ];
    const setCount = replica.filter((v) => v !== undefined).length;
    if (setCount !== 0 && setCount !== replica.length) {
      ctx.addIssue({
        code: "custom",
        path: ["PG_REPLICA_*"],
        message:
          "set PG_REPLICA_HOST, PG_REPLICA_USER and PG_REPLICA_PASSWORD together, or none of them",
      });
    }
    if (env.NODE_ENV === "production" && env.PG_SSL !== "verify-full") {
      ctx.addIssue({
        code: "custom",
        path: ["PG_SSL"],
        message: "must be verify-full in production",
      });
    }
  });

export type NodeEnv = "development" | "test" | "production";
export type PgSslMode = "disable" | "verify-full";

export interface PgConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string | undefined;
  readonly password: string | undefined;
}

export interface PostgresConfig {
  readonly database: string;
  readonly primary: PgConnectionConfig;
  /** null => reads go to primary (local dev without a replica). */
  readonly replica: PgConnectionConfig | null;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly ssl: PgSslMode;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly postgres: PostgresConfig;
}

export function loadConfig(source: NodeJS.ProcessEnv): AppConfig {
  const result = EnvSchema.safeParse(source);

  if (!result.success) {
    // Variable names and messages only. Never include values: they may be secrets.
    const details = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const env = result.data;

  const replica: PgConnectionConfig | null =
    env.PG_REPLICA_HOST && env.PG_REPLICA_USER && env.PG_REPLICA_PASSWORD
      ? Object.freeze({
          host: env.PG_REPLICA_HOST,
          port: env.PG_REPLICA_PORT,
          user: env.PG_REPLICA_USER,
          password: env.PG_REPLICA_PASSWORD,
        })
      : null;

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    postgres: Object.freeze({
      database: env.PG_DATABASE,
      primary: Object.freeze({
        host: env.PG_PRIMARY_HOST,
        port: env.PG_PRIMARY_PORT,
        user: env.PG_PRIMARY_USER,
        password: env.PG_PRIMARY_PASSWORD,
      }),
      replica,
      poolMax: env.PG_POOL_MAX,
      statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
      connectTimeoutMs: env.PG_CONNECT_TIMEOUT_MS,
      ssl: env.PG_SSL,
    }),
  });
}

export const config: AppConfig = loadConfig(process.env);
