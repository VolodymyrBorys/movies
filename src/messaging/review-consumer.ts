import { randomUUID } from "node:crypto";
import type { ChannelModel, ConfirmChannel, ConsumeMessage, Message } from "amqplib";
import type { Logger } from "pino";
import { reviewDeliveriesTotal } from "../infrastructure/metrics.ts";
import { REVIEW_CONSUMER_SETTINGS, type ReviewDelivery } from "../workers/review-handler.ts";
import {
  assertReviewConsumerTopology,
  REVIEWS_QUEUE,
  type ReviewRetryTier,
} from "./topology.ts";

// Review consumer (P5.4): a confirm channel that consumes `reviews.generate` with manual ack
// and hands each delivery to the handler (src/workers/review-handler.ts).
//
// Channel lifecycle mirrors PublishChannel (publish-channel.ts): recovery calls `open(model)`
// after every (re)connect; a channel-only close (e.g. 406 from a bad ack, consumer cancelled
// because the queue was deleted) is reopened on the same connection after a delay.
//
// Delivery tags are per channel: an ack for a message from a closed channel must never reach
// a new one (406 PRECONDITION_FAILED "unknown delivery tag" closes it). Every delivery is
// therefore bound to the channel it arrived on, and settles at most once.
//
// Graceful shutdown (P5.6): drain() cancels the consumer (no new deliveries) but keeps the
// channel open, because in-flight handlers still ack / publish retries on it; waits for them;
// on timeout calls `abortInFlight` (the worker aborts the generations) and waits a short grace;
// then closes the channel. Deliveries still unsettled at close are redelivered by the broker.

export const REVIEW_CONSUMER_REOPEN_DELAY_MS = 5_000;
export const RETRY_PUBLISH_TIMEOUT_MS = 10_000;

export type ReviewDeliveryHandler = (delivery: ReviewDelivery) => Promise<unknown>;

export interface DrainOptions {
  timeoutMs: number;
  /** Called once when `timeoutMs` passes with deliveries still in flight. */
  abortInFlight: () => void;
  /** Wait after `abortInFlight` before closing the channel. */
  abortGraceMs: number;
}

export interface DrainResult {
  /** In flight when the consumer was cancelled. */
  inFlightAtStart: number;
  /** `abortInFlight` was called. */
  aborted: boolean;
  /** Still in flight when the channel was closed (redelivered by the broker). */
  inFlightAtClose: number;
}

export interface ReviewConsumerOptions {
  prefetch: number;
  /** Test seams. */
  reopenDelayMs?: number;
  retryPublishTimeoutMs?: number;
  /** Pause before the handler-threw requeue (default: the handler's `requeueDelayMs`). */
  requeueDelayMs?: number;
}

export class ReviewConsumer {
  private channel: ConfirmChannel | null = null;
  private model: ChannelModel | null = null;
  private reopenTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private consumerTag: string | null = null;
  private drainPromise: Promise<DrainResult> | null = null;
  private inFlight = 0;
  private idleWaiters: (() => void)[] = [];
  private readonly handler: ReviewDeliveryHandler;
  private readonly logger: Logger;
  private readonly prefetch: number;
  private readonly reopenDelayMs: number;
  private readonly retryPublishTimeoutMs: number;
  private readonly requeueDelayMs: number;

  constructor(handler: ReviewDeliveryHandler, logger: Logger, options: ReviewConsumerOptions) {
    this.handler = handler;
    this.logger = logger;
    this.prefetch = options.prefetch;
    this.reopenDelayMs = options.reopenDelayMs ?? REVIEW_CONSUMER_REOPEN_DELAY_MS;
    this.retryPublishTimeoutMs = options.retryPublishTimeoutMs ?? RETRY_PUBLISH_TIMEOUT_MS;
    this.requeueDelayMs = options.requeueDelayMs ?? REVIEW_CONSUMER_SETTINGS.requeueDelayMs;
  }

  /**
   * `open()` for the recovery `setup` of a connection shared with other components (the
   * outbox relay): never rejects. A failure (e.g. 406 on a queue declared with different
   * arguments) is logged and retried on the same connection after `reopenDelayMs`, so it
   * doesn't tear down the connection and stop the relay with it.
   */
  async start(model: ChannelModel): Promise<void> {
    try {
      await this.open(model);
    } catch (error) {
      this.logger.error({ err: error }, "Review consumer failed to start; retrying");
      this.scheduleReopen(model);
    }
  }

  /** Deliveries handed to the handler and not finished yet. */
  inFlightCount(): number {
    return this.inFlight;
  }

  /**
   * Opens a confirm channel, declares the consumer topology, sets prefetch and starts
   * consuming. Used as (part of) the recovery `setup`: a rejection counts as a failed connect.
   */
  async open(model: ChannelModel): Promise<void> {
    if (this.closing) return;

    if (this.model !== model) {
      this.model = model;
      model.once("close", () => {
        if (this.model === model) this.model = null;
      });
    }

    const channel = await model.createConfirmChannel();
    channel.on("error", (err: Error) => this.logger.warn({ err }, "Review consumer channel error"));

    try {
      await assertReviewConsumerTopology(channel);
      // Per consumer (global=false): at most `prefetch` unacked deliveries on this channel.
      await channel.prefetch(this.prefetch);

      if (this.closing) {
        await channel.close().catch(() => undefined);
        return;
      }

      channel.on("close", () => {
        if (this.channel !== channel) return;
        this.channel = null;
        this.consumerTag = null;
        this.logger.warn("Review consumer channel closed");
        this.scheduleReopen(model);
      });
      this.channel = channel;
      this.clearReopenTimer();

      const { consumerTag } = await channel.consume(
        REVIEWS_QUEUE,
        (message) => this.onMessage(channel, message),
        { noAck: false },
      );
      if (this.channel === channel) this.consumerTag = consumerTag;
    } catch (error) {
      // Half-opened channel: detach it first so its close doesn't schedule a second reopen;
      // the caller (recovery setup or start()/scheduleReopen) decides how to retry.
      if (this.channel === channel) this.channel = null;
      await channel.close().catch(() => undefined);
      throw error;
    }
    this.logger.info({ queue: REVIEWS_QUEUE, prefetch: this.prefetch }, "Review consumer started");
  }

  /**
   * Graceful stop (see the header). Idempotent: a second call returns the first one's result.
   * Never rejects; a broker failure on the way only means the broker redelivers more.
   */
  drain(options: DrainOptions): Promise<DrainResult> {
    this.drainPromise ??= this.runDrain(options);
    return this.drainPromise;
  }

  private async runDrain(options: DrainOptions): Promise<DrainResult> {
    // No reopen from here on: a channel closing during the drain stays closed.
    this.closing = true;
    this.clearReopenTimer();

    const channel = this.channel;
    const consumerTag = this.consumerTag;
    if (channel !== null && consumerTag !== null) {
      try {
        // After cancel-ok the broker sends no more deliveries; those already sent are in
        // flight (prefetch window) and settle on this still-open channel.
        await channel.cancel(consumerTag);
      } catch (error) {
        this.logger.warn({ err: error }, "Review consumer cancel failed");
      }
    }

    const inFlightAtStart = this.inFlight;
    this.logger.info({ inFlight: inFlightAtStart }, "Review consumer draining");

    let aborted = false;
    if (!(await this.waitForIdle(options.timeoutMs))) {
      aborted = true;
      this.logger.warn(
        { inFlight: this.inFlight, timeoutMs: options.timeoutMs },
        "Review consumer drain timed out; aborting in-flight generations",
      );
      options.abortInFlight();
      await this.waitForIdle(options.abortGraceMs);
    }

    const inFlightAtClose = this.inFlight;
    await this.close();
    this.logger.info({ inFlightAtStart, aborted, inFlightAtClose }, "Review consumer drained");
    return { inFlightAtStart, aborted, inFlightAtClose };
  }

  /** true when nothing is in flight within `timeoutMs`. */
  private waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const onIdle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== onIdle);
        resolve(false);
      }, timeoutMs);
      this.idleWaiters.push(onIdle);
    });
  }

  /** Stops consuming by closing the channel (unacked deliveries go back to the queue). */
  async close(): Promise<void> {
    this.closing = true;
    this.clearReopenTimer();

    const channel = this.channel;
    this.channel = null;
    this.consumerTag = null;
    if (channel === null) return;

    try {
      await channel.close();
    } catch (error) {
      this.logger.debug({ err: error }, "Review consumer channel close failed");
    }
  }

  private onMessage(channel: ConfirmChannel, message: ConsumeMessage | null): void {
    if (message === null) {
      // The broker cancelled the consumer (queue deleted). Closing the channel triggers the
      // reopen, which re-declares the queue and consumes again.
      this.logger.warn({ queue: REVIEWS_QUEUE }, "Review consumer cancelled by the broker");
      channel.close().catch(() => undefined);
      return;
    }

    const delivery = this.createDelivery(channel, message);
    this.inFlight++;

    this.handler(delivery)
      .catch(async (error: unknown) => {
        // The handler settles every message itself; reaching this is a bug. Requeue so the
        // message isn't stuck unacked until the channel closes — after a pause: an explicit
        // requeue isn't counted by the delivery-limit, so a deterministic bug would otherwise
        // be a hot redelivery loop. (No-op if the handler settled before throwing.)
        reviewDeliveriesTotal.inc({ outcome: "handler_threw" });
        this.logger.error(
          { err: error, messageId: delivery.messageId, delayMs: this.requeueDelayMs },
          "Review handler threw; message requeued after a pause",
        );
        await new Promise((resolve) => setTimeout(resolve, this.requeueDelayMs));
        delivery.requeue();
      })
      .finally(() => {
        this.inFlight--;
        if (this.inFlight === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const waiter of waiters) waiter();
        }
      });
  }

  private createDelivery(channel: ConfirmChannel, message: ConsumeMessage): ReviewDelivery {
    let settled = false;
    const messageId =
      typeof message.properties.messageId === "string" ? message.properties.messageId : undefined;

    const settle = (action: "ack" | "dead_letter" | "requeue"): void => {
      // A second ack/nack of the same delivery tag is a channel error (406): settle once.
      if (settled) return;
      settled = true;
      try {
        if (action === "ack") channel.ack(message);
        else channel.nack(message, false, action === "requeue");
      } catch (error) {
        // Channel already closed: the broker requeues the delivery by itself.
        this.logger.warn({ err: error, messageId, action }, "Could not settle review delivery");
      }
    };

    return {
      content: message.content,
      messageId,
      redelivered: message.fields.redelivered,
      ack: () => settle("ack"),
      deadLetter: () => settle("dead_letter"),
      requeue: () => settle("requeue"),
      publishRetry: (tier, failedAttempt) =>
        this.publishRetry(channel, message, messageId, tier, failedAttempt),
    };
  }

  /**
   * Copies the message into the retry queue (default exchange, routed by queue name) and
   * waits for the publisher confirm. `mandatory` + basic.return: a missing retry queue must
   * not look like success (the job would be left `queued` with no message).
   */
  private publishRetry(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    messageId: string | undefined,
    tier: ReviewRetryTier,
    failedAttempt: number,
  ): Promise<boolean> {
    // Matches basic.return to this publish (messageId alone may repeat across duplicates).
    const retryId = randomUUID();

    return new Promise<boolean>((resolve) => {
      let returned = false;
      let done = false;

      const onReturn = (returnedMessage: Message) => {
        const headers: unknown = returnedMessage.properties.headers;
        if (
          typeof headers === "object" &&
          headers !== null &&
          (headers as Record<string, unknown>)["x-retry-id"] === retryId
        ) {
          returned = true;
        }
      };

      const finish = (ok: boolean, reason?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        channel.off("return", onReturn);
        if (!ok) {
          this.logger.warn({ messageId, retryQueue: tier.queue, reason }, "Retry publish failed");
        }
        resolve(ok);
      };

      const timer = setTimeout(
        () => finish(false, `no confirm within ${this.retryPublishTimeoutMs} ms`),
        this.retryPublishTimeoutMs,
      );
      channel.on("return", onReturn);

      try {
        channel.publish(
          "",
          tier.queue,
          message.content,
          {
            persistent: true,
            mandatory: true,
            ...(messageId !== undefined ? { messageId } : {}),
            contentType: "application/json",
            ...(typeof message.properties.type === "string"
              ? { type: message.properties.type }
              : {}),
            timestamp: Math.floor(Date.now() / 1000),
            // Informational only: DB attempts are authoritative. The original headers (incl.
            // x-death from earlier dead-lettering) are not copied.
            headers: { "x-retry-id": retryId, "x-review-failed-attempt": failedAttempt },
          },
          (err: unknown) => {
            if (err) finish(false, err instanceof Error ? err.message : String(err));
            else if (returned) finish(false, "unroutable: retry queue missing");
            else finish(true);
          },
        );
      } catch (error) {
        finish(false, error instanceof Error ? error.message : String(error));
      }
    });
  }

  private clearReopenTimer(): void {
    if (this.reopenTimer !== null) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
  }

  private scheduleReopen(model: ChannelModel): void {
    if (this.closing || this.reopenTimer !== null) return;

    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      if (this.closing || this.model !== model || this.channel !== null) return;

      this.open(model).catch((error: unknown) => {
        this.logger.warn({ err: error }, "Review consumer reopen failed; retrying");
        this.scheduleReopen(model);
      });
    }, this.reopenDelayMs);
  }
}
