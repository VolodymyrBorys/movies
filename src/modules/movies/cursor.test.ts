import { describe, expect, it } from "vitest";
import { decodeMovieCursor, encodeMovieCursor } from "./cursor.ts";

const ID = "0b9c6a52-6f0e-4c3b-9a43-8f1f2d1e7a10";

const raw = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("movie cursor", () => {
  it("returns null when no cursor is given", () => {
    expect(decodeMovieCursor(undefined)).toBeNull();
  });

  it("round-trips created_at with microsecond precision", () => {
    // Two rows in the same millisecond differ only in microseconds;
    // a Date-based cursor would collapse them.
    const a = { createdAt: "2026-11-16T12:34:56.123456Z", id: ID };
    const b = { createdAt: "2026-11-16T12:34:56.123999Z", id: ID };

    expect(decodeMovieCursor(encodeMovieCursor(a))).toEqual(a);
    expect(decodeMovieCursor(encodeMovieCursor(b))).toEqual(b);
    expect(encodeMovieCursor(a)).not.toBe(encodeMovieCursor(b));
  });

  it("produces URL-safe cursors", () => {
    const cursor = encodeMovieCursor({
      createdAt: "2026-11-16T12:34:56.123456Z",
      id: ID,
    });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["empty", ""],
    ["too long", "a".repeat(129)],
    ["not base64url", "%%%"],
    ["non-canonical (padding)", `${raw(`2026-11-16T12:34:56.123456Z,${ID}`)}=`],
    ["missing id", raw("2026-11-16T12:34:56.123456Z")],
    ["extra part", raw(`2026-11-16T12:34:56.123456Z,${ID},x`)],
    ["millisecond precision", raw(`2026-11-16T12:34:56.123Z,${ID}`)],
    ["no timezone", raw(`2026-11-16T12:34:56.123456,${ID}`)],
    ["impossible month/day", raw(`2026-13-45T12:34:56.123456Z,${ID}`)],
    ["Feb 30", raw(`2026-02-30T12:34:56.123456Z,${ID}`)],
    ["hour 25", raw(`2026-11-16T25:00:00.000000Z,${ID}`)],
    ["bigint id (old format)", raw("42")],
    ["uppercase uuid", raw(`2026-11-16T12:34:56.123456Z,${ID.toUpperCase()}`)],
    ["sql in id", raw("2026-11-16T12:34:56.123456Z,1' OR '1'='1")],
  ])("rejects %s", (_name, cursor) => {
    expect(() => decodeMovieCursor(cursor)).toThrow("Invalid cursor");
  });
});
