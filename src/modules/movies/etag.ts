// Optimistic concurrency for movies over HTTP (RFC 9110 §8.8.3, §13.1.1).
//
// The entity tag is the row's `version` (NOT NULL, bumped by every UPDATE through the API):
// a strong tag `"<version>"`. A client sends it back in `If-Match`; the UPDATE applies only
// if the row still has that version, otherwise 412 — no lost update.
//
// LAB: simplified — a direct SQL UPDATE that doesn't bump `version` would keep the same tag.
// Production would bump it in a trigger or keep all writes behind the API.

import { AppError } from "../../utils/errors.ts";

export function movieEtag(version: number): string {
  return `"${version}"`;
}

/** Parsed `If-Match`: `any` = "*", `versions` = strong tags we can compare (may be empty). */
export type IfMatch =
  | { kind: "any" }
  | { kind: "versions"; versions: number[] };

export class InvalidIfMatchError extends AppError {
  constructor() {
    super('If-Match must be "*" or a list of quoted entity tags', {
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    this.name = "InvalidIfMatchError";
  }
}

// int4 max is 2147483647; 9 digits always fit, longer tags simply can't match a version.
const OUR_STRONG_TAG = /^"(\d{1,9})"$/;
const ANY_STRONG_TAG = /^"[\x21\x23-\x7e]*"$/;
const WEAK_TAG = /^W\/"[\x21\x23-\x7e]*"$/;

/** Returns null when the header is absent (no precondition). Throws on malformed input. */
export function parseIfMatch(header: string | undefined): IfMatch | null {
  if (header === undefined) {
    return null;
  }

  const value = header.trim();

  if (value === "*") {
    return { kind: "any" };
  }

  const versions: number[] = [];

  for (const raw of value.split(",")) {
    const tag = raw.trim();
    const ours = OUR_STRONG_TAG.exec(tag);

    if (ours) {
      versions.push(Number(ours[1]));
    } else if (WEAK_TAG.test(tag) || ANY_STRONG_TAG.test(tag)) {
      // Weak tags never match under If-Match's strong comparison; other strong tags were
      // never issued by us. Both are valid syntax that just can't match → 412, not 400.
      continue;
    } else {
      throw new InvalidIfMatchError();
    }
  }

  return { kind: "versions", versions };
}
