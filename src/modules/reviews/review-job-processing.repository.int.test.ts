import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PG } from "../../infrastructure/postgres.ts";
import {
  insertMovie,
  resetState,
  startInfrastructure,
  stopInfrastructure,
} from "../../test/integration-db.ts";
import { reviewJobProcessingRepository as repo } from "./review-job-processing.repository.ts";

// Integration: review job state transitions (P5.4) against real PostgreSQL, incl. the CHECK
// constraints of review_jobs (lease ⇔ running, result ⇔ succeeded, finished ⇔ terminal).

beforeAll(startInfrastructure);
afterAll(stopInfrastructure);
beforeEach(resetState);

const OPTIONS = { workerId: "worker-a", leaseSeconds: 120, maxAttempts: 5 };

interface JobRow {
  status: string;
  attempts: number;
  locked_by: string | null;
  locked_until: Date | null;
  review: string | null;
  model: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  last_error: string | null;
}

// SQL fragments below are test constants, never input.
async function insertJob(
  movieId: string,
  fields: {
    movieVersion?: number;
    status?: string;
    attempts?: number;
    lockedBy?: string | null;
    lockedUntilSql?: string;
  } = {},
): Promise<string> {
  const status = fields.status ?? "queued";
  const terminal = ["succeeded", "failed", "superseded"].includes(status);
  const { rows } = await PG.writeQuery<{ id: string }>(
    `
      INSERT INTO review_jobs
        (movie_id, movie_version, status, attempts, locked_by, locked_until,
         review, model, finished_at)
      VALUES ($1, $2, $3, $4, $5, ${fields.lockedUntilSql ?? "NULL"},
              $6, $6, ${terminal ? "now()" : "NULL"})
      RETURNING id
    `,
    [
      movieId,
      fields.movieVersion ?? 1,
      status,
      fields.attempts ?? 0,
      fields.lockedBy ?? null,
      status === "succeeded" ? "done" : null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("insertJob returned no id");
  return id;
}

async function job(id: string): Promise<JobRow> {
  const { rows } = await PG.writeQuery<JobRow>("SELECT * FROM review_jobs WHERE id = $1", [id]);
  const row = rows[0];
  if (row === undefined) throw new Error(`job ${id} not found`);
  return row;
}

async function movie(version = 1): Promise<string> {
  return insertMovie({ createdAt: "2024-01-01T00:00:00Z", version });
}

describe("claim", () => {
  it("queued → running with lease, one more attempt and the movie data", async () => {
    const jobId = await insertJob(await movie());

    const result = await repo.claim(jobId, OPTIONS);

    expect(result).toEqual({
      kind: "claimed",
      attempts: 1,
      movieVersion: 1,
      movie: { title: "Test movie", description: null, releaseYear: 2000, durationMinutes: 100 },
      leaseToken: expect.stringMatching(/^worker-a:[0-9a-f-]{36}$/),
    });
    const row = await job(jobId);
    expect(row).toMatchObject({
      status: "running",
      attempts: 1,
      locked_by: result.kind === "claimed" ? result.leaseToken : "unreachable",
    });
    expect(row.started_at).not.toBeNull();
    const leaseMs = (row.locked_until?.getTime() ?? 0) - Date.now();
    expect(leaseMs).toBeGreaterThan(100_000);
    expect(leaseMs).toBeLessThanOrEqual(120_000);
  });

  it("returns missing for an unknown job (movie deleted → cascade)", async () => {
    const jobId = await insertJob(await movie());
    await PG.writeQuery("DELETE FROM movies");

    expect(await repo.claim(jobId, OPTIONS)).toEqual({ kind: "missing" });
  });

  it.each(["succeeded", "failed", "superseded"])("leaves a %s job untouched", async (status) => {
    const jobId = await insertJob(await movie(), { status });

    expect(await repo.claim(jobId, OPTIONS)).toEqual({ kind: "terminal", status });
    expect((await job(jobId)).status).toBe(status);
  });

  it("reports lease_busy for a running job with a live lease", async () => {
    const jobId = await insertJob(await movie(), {
      status: "running",
      attempts: 2,
      lockedBy: "worker-b",
      lockedUntilSql: "now() + interval '60 seconds'",
    });

    expect(await repo.claim(jobId, OPTIONS)).toEqual({ kind: "lease_busy", attempts: 2 });
    expect((await job(jobId)).locked_by).toBe("worker-b");
  });

  it("takes over a running job whose lease expired", async () => {
    const jobId = await insertJob(await movie(), {
      status: "running",
      attempts: 2,
      lockedBy: "worker-b",
      lockedUntilSql: "now() - interval '1 second'",
    });

    const result = await repo.claim(jobId, OPTIONS);

    expect(result).toMatchObject({ kind: "claimed", attempts: 3 });
    expect((await job(jobId)).locked_by).toMatch(/^worker-a:/);
  });

  it("supersedes a job whose movie version changed", async () => {
    const jobId = await insertJob(await movie(2), { movieVersion: 1 });

    expect(await repo.claim(jobId, OPTIONS)).toEqual({
      kind: "superseded",
      jobVersion: 1,
      currentVersion: 2,
    });
    const row = await job(jobId);
    expect(row).toMatchObject({ status: "superseded", attempts: 0, locked_by: null });
    expect(row.finished_at).not.toBeNull();
  });

  it("fails a job whose attempts are exhausted (crash loop)", async () => {
    const jobId = await insertJob(await movie(), {
      status: "running",
      attempts: 5,
      lockedBy: "worker-b",
      lockedUntilSql: "now() - interval '1 second'",
    });

    expect(await repo.claim(jobId, OPTIONS)).toEqual({ kind: "exhausted", attempts: 5 });
    const row = await job(jobId);
    expect(row).toMatchObject({ status: "failed", locked_by: null });
    expect(row.last_error).toMatch(/attempts exhausted/);
  });

  it("a claim waits for a concurrent claim's row lock, then sees lease_busy", async () => {
    // Deterministic interleaving: transaction A takes the row lock and claims, and stays open
    // until B is observed waiting on a lock. Without FOR UPDATE in claim(), B would read the
    // pre-A snapshot (`queued`), block only at its UPDATE, then overwrite A's claim → `claimed`
    // with attempts 2. (A Promise.all of two claims passes either way when A commits first.)
    const jobId = await insertJob(await movie());
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aClaimed!: () => void;
    const aHasClaimed = new Promise<void>((resolve) => {
      aClaimed = resolve;
    });

    const transactionA = PG.transaction(async (client) => {
      await client.query("SELECT 1 FROM review_jobs WHERE id = $1 FOR UPDATE", [jobId]);
      await client.query(
        `UPDATE review_jobs
         SET status = 'running', attempts = attempts + 1, locked_by = 'worker-a:held',
             locked_until = now() + interval '120 seconds', started_at = now()
         WHERE id = $1`,
        [jobId],
      );
      aClaimed();
      await aMayCommit;
    });

    try {
      await aHasClaimed;
      const claimB = repo.claim(jobId, { ...OPTIONS, workerId: "worker-b" });

      await expect
        .poll(async () => {
          const { rows } = await PG.writeQuery<{ waiting: number }>(
            `SELECT count(*)::int AS waiting
             FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          return rows[0]?.waiting;
        })
        .toBe(1);

      releaseA();
      await transactionA;

      expect(await claimB).toEqual({ kind: "lease_busy", attempts: 1 });
      expect(await job(jobId)).toMatchObject({ attempts: 1, locked_by: "worker-a:held" });
    } finally {
      releaseA();
      await transactionA.catch(() => undefined);
    }
  });

  it("two claims of one job by the SAME worker get different lease tokens (prefetch > 1)", async () => {
    const jobId = await insertJob(await movie());
    const first = await repo.claim(jobId, OPTIONS);
    // First delivery's lease expires while it is still generating; a second delivery of the
    // same job in the same process takes it over.
    await PG.writeQuery(
      "UPDATE review_jobs SET locked_until = now() - interval '1 second' WHERE id = $1",
      [jobId],
    );
    const second = await repo.claim(jobId, OPTIONS);
    if (first.kind !== "claimed" || second.kind !== "claimed") throw new Error("not claimed");

    expect(second.leaseToken).not.toBe(first.leaseToken);
    // The stale first claim can no longer finish the job...
    expect(await repo.complete(jobId, first.leaseToken, { review: "stale", model: "m" })).toBe(
      false,
    );
    // ...the current one can.
    expect(await repo.complete(jobId, second.leaseToken, { review: "new", model: "m" })).toBe(true);
    expect(await job(jobId)).toMatchObject({ status: "succeeded", review: "new", attempts: 2 });
  });
});

describe("outcomes are guarded by the lease owner", () => {
  async function claimedJob(): Promise<{ jobId: string; token: string }> {
    const jobId = await insertJob(await movie());
    const claim = await repo.claim(jobId, OPTIONS);
    if (claim.kind !== "claimed") throw new Error(`expected claimed, got ${claim.kind}`);
    return { jobId, token: claim.leaseToken };
  }

  it("complete → succeeded with the result, lease cleared", async () => {
    const { jobId, token } = await claimedJob();

    expect(await repo.complete(jobId, token, { review: "Good.", model: "stub" })).toBe(true);
    const row = await job(jobId);
    expect(row).toMatchObject({
      status: "succeeded",
      review: "Good.",
      model: "stub",
      locked_by: null,
      locked_until: null,
      last_error: null,
    });
    expect(row.finished_at).not.toBeNull();
  });

  it("release → queued, lease cleared, error kept, attempts kept", async () => {
    const { jobId, token } = await claimedJob();

    expect(await repo.release(jobId, token, "503")).toBe(true);
    expect(await job(jobId)).toMatchObject({
      status: "queued",
      attempts: 1,
      locked_by: null,
      last_error: "503",
    });
  });

  it("fail → failed, finished", async () => {
    const { jobId, token } = await claimedJob();

    expect(await repo.fail(jobId, token, "bad input")).toBe(true);
    const row = await job(jobId);
    expect(row).toMatchObject({ status: "failed", locked_by: null, last_error: "bad input" });
    expect(row.finished_at).not.toBeNull();
  });

  it.each(["complete", "release", "fail"] as const)(
    "%s with a token that doesn't hold the lease changes nothing",
    async (method) => {
      const { jobId, token } = await claimedJob();
      // Same worker id, different claim: the guard is per claim, not per process.
      const otherClaim = "worker-a:00000000-0000-0000-0000-000000000000";

      const ok =
        method === "complete"
          ? await repo.complete(jobId, otherClaim, { review: "x", model: "y" })
          : await repo[method](jobId, otherClaim, "err");

      expect(ok).toBe(false);
      expect(await job(jobId)).toMatchObject({ status: "running", locked_by: token });
    },
  );
});
