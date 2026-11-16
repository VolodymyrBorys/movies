// src/movies/movies.cursor.ts

export function encodeMovieCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64");
}

export function decodeMovieCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;

  if (cursor.length === 0 || cursor.length > 128) {
    throw new Error("Invalid cursor");
  }

  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const canonical = Buffer.from(decoded, "utf8").toString("base64");

  if (canonical !== cursor) throw new Error("Invalid cursor");
  // Припущення: id — додатний BIGINT.
  if (!/^[1-9]\d*$/.test(decoded)) throw new Error("Invalid cursor");

  const id = BigInt(decoded);

  if (id > 9_223_372_036_854_775_807n) throw new Error("Invalid cursor");

  return decoded;
}
