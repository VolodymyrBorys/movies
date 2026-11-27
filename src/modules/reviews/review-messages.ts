import { z } from "zod";

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

// Consumer-side validation: the queue is a trust boundary (anyone with publish rights on the
// exchange can put a message there). Extra fields are tolerated for forward compatibility.
const reviewRequestedMessageSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
  movieId: z.uuid(),
  movieVersion: z.number().int().min(1),
});

export type ParseReviewRequestedResult =
  | { ok: true; message: ReviewRequestedMessage }
  | { ok: false; error: string };

export function parseReviewRequestedMessage(content: Buffer): ParseReviewRequestedResult {
  let json: unknown;
  try {
    json = JSON.parse(content.toString("utf8"));
  } catch {
    return { ok: false, error: "body is not valid JSON" };
  }

  const result = reviewRequestedMessageSchema.safeParse(json);
  if (!result.success) {
    // Paths and messages only, never the values (body is untrusted).
    const details = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `invalid review.requested message: ${details}` };
  }

  return { ok: true, message: result.data };
}
