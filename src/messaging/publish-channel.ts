import type { ChannelModel, ConfirmChannel } from "amqplib";
import type { Logger } from "pino";
import { assertPublisherTopology } from "./topology.ts";

// Holds the worker's confirm channel for the outbox relay.
//
// Two ways to lose it:
// - Connection lost: amqplib recovery reconnects and calls `open(newModel)` as its `setup`.
//   amqplib closes the channels BEFORE the connection emits 'close', so the channel close
//   handler still sees the old model and schedules a reopen; that timer is cleared by the
//   successful `open(newModel)` (otherwise it would block a later reopen on the new model).
// - Channel-level error while the connection stays up (e.g. publish to a deleted exchange →
//   404 closes only the channel): recovery doesn't notice, so we reopen on the same
//   connection after a delay. If that connection has meanwhile closed, the reopen is skipped
//   and recovery takes over.
//
// `current()` is null — and the relay claims nothing, so attempts aren't burned — while no
// channel is open or while the broker blocks the connection (memory/disk alarm: publishes
// would sit in the socket buffer, time out and be retried, dead-lettering the backlog during
// a long alarm).

export const PUBLISH_CHANNEL_REOPEN_DELAY_MS = 5_000;

export class PublishChannel {
  private channel: ConfirmChannel | null = null;
  private model: ChannelModel | null = null;
  private blocked = false;
  private reopenTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private readonly logger: Logger;
  private readonly reopenDelayMs: number;

  constructor(logger: Logger, reopenDelayMs: number = PUBLISH_CHANNEL_REOPEN_DELAY_MS) {
    this.logger = logger;
    this.reopenDelayMs = reopenDelayMs;
  }

  current(): ConfirmChannel | null {
    return this.blocked ? null : this.channel;
  }

  /**
   * Opens a confirm channel and declares the publisher topology. Used as the recovery
   * `setup`: a rejection counts as a failed connect and recovery retries.
   * After close() it opens nothing (startup racing a shutdown signal).
   */
  async open(model: ChannelModel): Promise<void> {
    if (this.closing) return;

    if (this.model !== model) {
      this.model = model;
      // A new connection starts unblocked; the broker re-sends `blocked` if the alarm persists.
      this.blocked = false;
      model.once("close", () => {
        if (this.model === model) this.model = null;
      });
      model.on("blocked", () => {
        if (this.model === model) this.blocked = true;
      });
      model.on("unblocked", () => {
        if (this.model === model) this.blocked = false;
      });
    }

    const channel = await model.createConfirmChannel();
    // Before anything else: an unhandled 'error' event would crash the process.
    channel.on("error", (err: Error) => this.logger.warn({ err }, "Publish channel error"));

    await assertPublisherTopology(channel);

    if (this.closing) {
      await channel.close().catch(() => undefined);
      return;
    }

    channel.on("close", () => {
      if (this.channel !== channel) return;
      this.channel = null;
      this.logger.warn("Publish channel closed");
      this.scheduleReopen(model);
    });

    this.channel = channel;
    this.clearReopenTimer();
    this.logger.info("Publish channel open");
  }

  /** Closes the channel and stops reopening. The connection is closed by the caller. */
  async close(): Promise<void> {
    this.closing = true;
    this.clearReopenTimer();

    const channel = this.channel;
    this.channel = null;
    if (channel === null) return;

    try {
      await channel.close();
    } catch (error) {
      // Already closed together with the connection.
      this.logger.debug({ err: error }, "Publish channel close failed");
    }
  }

  private clearReopenTimer(): void {
    if (this.reopenTimer !== null) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
  }

  private scheduleReopen(model: ChannelModel): void {
    if (this.closing || this.reopenTimer !== null) return;

    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      // Connection gone (recovery will call open() with a new one), or already reopened.
      if (this.closing || this.model !== model || this.channel !== null) return;

      this.open(model).catch((error: unknown) => {
        this.logger.warn({ err: error }, "Publish channel reopen failed; retrying");
        this.scheduleReopen(model);
      });
    }, this.reopenDelayMs);
  }
}
