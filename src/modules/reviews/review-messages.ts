// Broker message contract between the API (producer, via message_outbox) and the review
// consumer (P5.4). Changing a field is a contract change: bump schemaVersion and keep the
// consumer able to read the previous version while old messages may still be queued.

export const REVIEW_REQUESTED_ROUTING_KEY = "review.requested";

export interface ReviewRequestedMessage {
  schemaVersion: 1;
  jobId: string;
  movieId: string;
  /** Movie version the job was created for; the consumer supersedes the job if it changed. */
  movieVersion: number;
}
