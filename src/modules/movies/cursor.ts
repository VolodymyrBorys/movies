// Keyset cursor for `movies` ordered by (created_at, id).
//
// The cursor carries created_at as a UTC string with MICROsecond precision, produced by
// PostgreSQL (to_char ... "US"). It must never go through JS Date: Date keeps only
// milliseconds, so rows sharing the same millisecond would be skipped or repeated at
// page boundaries.
//
// Format (opaque to clients): base64url("<created_at>,<uuid>").

export interface MovieCursor {
  /** e.g. "2026-11-16T12:34:56.123456Z" */
  createdAt: string;
  /** lowercase uuid as returned by PostgreSQL */
  id: string;
}

const CREATED_AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Calendar check (rejects 02-30, 13th month, 25:00) so a crafted cursor becomes a 400,
// not a PostgreSQL cast error (500).
function isValidUtcTimestamp(value: string): boolean {
  const m = CREATED_AT_RE.exec(value);
  if (m === null) return false;

  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number, number, number, number, number, number,
  ];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));

  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s
  );
}

export function encodeMovieCursor(cursor: MovieCursor): string {
  return Buffer.from(`${cursor.createdAt},${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

export function decodeMovieCursor(
  cursor: string | undefined,
): MovieCursor | null {
  if (cursor === undefined) return null;

  if (cursor.length === 0 || cursor.length > 128) {
    throw new Error("Invalid cursor");
  }

  const decoded = Buffer.from(cursor, "base64url").toString("utf8");

  // Reject non-canonical encodings so one position has exactly one cursor
  // (cursor is part of the cache key).
  if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
    throw new Error("Invalid cursor");
  }

  const parts = decoded.split(",");
  const [createdAt, id] = parts;

  if (
    parts.length !== 2 ||
    createdAt === undefined ||
    id === undefined ||
    !isValidUtcTimestamp(createdAt) ||
    !UUID_RE.test(id)
  ) {
    throw new Error("Invalid cursor");
  }

  return { createdAt, id };
}
