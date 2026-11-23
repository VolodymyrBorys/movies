import { EventEmitter } from "node:events";
import type { Options } from "amqplib";
import type { RelayChannel } from "../workers/outbox-relay.ts";

// In-memory stand-in for an amqplib ConfirmChannel, as far as the outbox relay uses it.
// `behavior` decides per publish how the "broker" answers.

export interface PublishedMessage {
  exchange: string;
  routingKey: string;
  body: unknown;
  options: Options.Publish;
}

type ConfirmCallback = (err: unknown, ok?: unknown) => void;

export type PublishBehavior =
  | "ack"
  | "nack"
  | "return" // unroutable with mandatory: basic.return, then basic.ack
  | "never" // no confirm at all
  | "throw" // channel already closed: publish() throws synchronously
  | "full" // ack, but publish() returns false (write buffer full)
  | ((message: PublishedMessage, confirm: ConfirmCallback) => void);

export class FakeConfirmChannel extends EventEmitter {
  readonly published: PublishedMessage[] = [];
  private attempted = 0;

  /** One behavior for every publish, or one per publish index ("ack" past the end). */
  behavior: PublishBehavior | PublishBehavior[];

  constructor(behavior: PublishBehavior | PublishBehavior[] = "ack") {
    super();
    this.behavior = behavior;
  }

  asRelayChannel(): RelayChannel {
    return this as unknown as RelayChannel;
  }

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
    callback: ConfirmCallback,
  ): boolean {
    const message: PublishedMessage = {
      exchange,
      routingKey,
      body: JSON.parse(content.toString()),
      options,
    };
    const index = this.attempted++;
    const behavior = Array.isArray(this.behavior)
      ? (this.behavior[index] ?? "ack")
      : this.behavior;

    if (behavior === "throw") throw new Error("Channel closed");
    this.published.push(message);

    // Confirms are asynchronous, like frames arriving from the socket.
    switch (behavior) {
      case "ack":
      case "full":
        setImmediate(() => callback(null));
        return behavior === "ack";
      case "nack":
        setImmediate(() => callback(new Error("message nacked")));
        return true;
      case "return":
        setImmediate(() => {
          this.emit("return", { properties: { messageId: options.messageId } });
          callback(null);
        });
        return true;
      case "never":
        return true;
      default:
        behavior(message, callback);
        return true;
    }
  }
}
