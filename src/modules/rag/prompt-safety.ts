// Structural hardening of untrusted text placed inside prompt blocks (D6).
//
// Prompts wrap untrusted data in tags (<context>, <movie>, <question>). Text that contains
// such a tag could close the block early and make what follows look like part of the
// prompt itself. neutralizeDelimiters escapes the "<" of every tag with one of our names, so
// no untrusted text can open or close a block. Everything else stays verbatim (code
// samples like `Promise<T>` or `a < b` are common in technical documents).
//
// LAB: simplified — this prevents breaking out of a block, NOT prompt injection: the model
// can still follow instructions written inside the data. Not covered: Unicode look-alikes
// (e.g. fullwidth "＜/context＞"), which a model may read as a tag. Production would also
// add spotlighting/random boundaries, output filtering and an injection eval set (P8).

export const PROMPT_DELIMITER_TAGS = ["context", "movie", "question"] as const;

// "<" followed by an optional "/" and one of our tag names, with optional whitespace,
// case-insensitive. \b keeps `<contextual>` untouched. The tag doesn't need a closing ">":
// an unterminated `</context` may still read as one.
const DELIMITER_TAG_START = new RegExp(
  `<(?=\\s*/?\\s*(?:${PROMPT_DELIMITER_TAGS.join("|")})\\b)`,
  "gi",
);

/**
 * Escapes the "<" of our delimiter tags as "&lt;". Idempotent: an escaped tag no longer
 * starts with "<", so a second pass changes nothing.
 */
export function neutralizeDelimiters(text: string): string {
  return text.replace(DELIMITER_TAG_START, "&lt;");
}

// \r\n first, so a CRLF becomes one space.
const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029]/g;

/**
 * For values inserted into one-line prompt headers ("Title: …", "[Source: …]"): a line
 * break would let the value add a fake header line of its own.
 */
export function toSingleLine(text: string): string {
  return text.replace(LINE_BREAKS, " ");
}
