import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PG } from "../infrastructure/postgres.ts";
import { FakeConfirmChannel } from "../test/fake-confirm-channel.ts";
import { resetState, startInfrastructure, stopInfrastructure } from "../test/integration-db.ts";
import { OUTBOX_RELAY_SETTINGS, runOutboxRelayBatch } from "./outbox-relay.ts";

// Integration: outbox relay against real PostgreSQL, broker replaced by FakeConfirmChannel.
// Live broker behaviour (confirms, mandatory returns) is checked manually with `npm run worker`.

beforeAll(startInfrastructure);
afterAll(stopInfrastructure);
beforeEach(resetState);

interface MessageRow {
  id: string;
  message_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  locked_by: string | null;
  locked_until: Date | null;
  available_at: Date;
  published_at: Date | null;
  dead_lettered_at: Date | null;
  last_error: string | null;
}

// SQL fragments below are test constants, never input.
async function insertMessage(
  fields: {
    jobId?: string;
    attempts?: number;
    availableAtSql?: string;
    lockedBy?: string | null;
    lockedUntilSql?: string;
  } = {},
): Promise<MessageRow> {
  const { rows } = await PG.writeQuery<MessageRow>(
    `
      INSERT INTO message_outbox
        (aggregate_type, aggregate_id, routing_key, payload, attempts, available_at,
         locked_by, locked_until)
      VALUES ('review_job', $1, 'review.requested', $2::jsonb, $3,
              ${fields.availableAtSql ?? "now()"}, $4, ${fields.lockedUntilSql ?? "NULL"})
      RETURNING *
    `,
    [
      fields.jobId ?? "job",
      JSON.stringify({ schemaVersion: 1, jobId: fields.jobId ?? "job" }),
      fields.attempts ?? 0,
      fields.lockedBy ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("insert returned no row");
  return row;
}

async function messageRows(): Promise<MessageRow[]> {
  const { rows } = await PG.writeQuery<MessageRow>("SELECT * FROM message_outbox ORDER BY id");
  return rows;
}

describe("outbox relay", () => {
  it("publishes with the stored message_id and payload, then marks the row published", async () => {
    const inserted = await insertMessage({ jobId: "job-1" });
    const channel = new FakeConfirmChannel("ack");

    expect(await runOutboxRelayBatch(channel.asRelayChannel())).toBe(1);

    expect(channel.published).toHaveLength(1);
    expect(channel.published[0]?.options.messageId).toBe(inserted.message_id);
    expect(channel.published[0]?.body).toEqual({ schemaVersion: 1, jobId: "job-1" });

    const [row] = await messageRows();
    expect(row).toMatchObject({
      attempts: 1,
      locked_by: null,
      locked_until: null,
      last_error: null,
      dead_lettered_at: null,
    });
    expect(row?.published_at).toBeInstanceOf(Date);
    expect(await runOutboxRelayBatch(channel.asRelayChannel())).toBe(0);
  });

  it("keeps an unroutable message pending with a backoff and the reason", async () => {
    await insertMessage();

    await runOutboxRelayBatch(new FakeConfirmChannel("return").asRelayChannel());

    const [row] = await messageRows();
    expect(row).toMatchObject({ attempts: 1, locked_by: null, published_at: null });
    expect(row?.last_error).toMatch(/^unroutable/);
    expect(row?.available_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("dead-letters after the last attempt", async () => {
    await insertMessage({ attempts: OUTBOX_RELAY_SETTINGS.maxAttempts - 1 });

    await runOutboxRelayBatch(new FakeConfirmChannel("nack").asRelayChannel());

    const [row] = await messageRows();
    expect(row).toMatchObject({
      attempts: OUTBOX_RELAY_SETTINGS.maxAttempts,
      locked_by: null,
      published_at: null,
      last_error: "message nacked",
    });
    expect(row?.dead_lettered_at).toBeInstanceOf(Date);
  });

  it("two concurrent relays never publish a message twice (no duplicates; not specific to SKIP LOCKED)", async () => {
    for (let i = 0; i < 20; i++) await insertMessage({ jobId: `job-${i}` });
    const a = new FakeConfirmChannel("ack");
    const b = new FakeConfirmChannel("ack");

    await Promise.all([
      runOutboxRelayBatch(a.asRelayChannel()),
      runOutboxRelayBatch(b.asRelayChannel()),
    ]);

    const ids = [...a.published, ...b.published].map((m) => m.options.messageId);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect((await messageRows()).every((r) => r.published_at !== null)).toBe(true);
  });

  it("skips rows under an active lease or not yet available, takes over an expired lease", async () => {
    await insertMessage({ jobId: "active", lockedBy: "other", lockedUntilSql: "now() + interval '1 minute'" });
    await insertMessage({ jobId: "future", availableAtSql: "now() + interval '1 minute'" });
    await insertMessage({ jobId: "expired", lockedBy: "dead", lockedUntilSql: "now() - interval '1 second'" });
    const channel = new FakeConfirmChannel("ack");

    expect(await runOutboxRelayBatch(channel.asRelayChannel())).toBe(1);

    expect(channel.published.map((m) => m.body)).toEqual([{ schemaVersion: 1, jobId: "expired" }]);
  });

  it("publishes in (available_at, id) order", async () => {
    await insertMessage({ jobId: "later", availableAtSql: "now() - interval '1 second'" });
    await insertMessage({ jobId: "earlier", availableAtSql: "now() - interval '2 seconds'" });
    const channel = new FakeConfirmChannel("ack");

    await runOutboxRelayBatch(channel.asRelayChannel());

    expect(channel.published.map((m) => (m.body as { jobId: string }).jobId)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("does not mark a confirmed message when the lease was lost meanwhile", async () => {
    await insertMessage();
    // Another relay takes the row over before our confirm arrives.
    const channel = new FakeConfirmChannel((_message, confirm) => {
      void PG.writeQuery("UPDATE message_outbox SET locked_by = 'other'").then(() => confirm(null));
    });

    await runOutboxRelayBatch(channel.asRelayChannel());

    const [row] = await messageRows();
    expect(row).toMatchObject({ locked_by: "other", published_at: null });
  });
});
