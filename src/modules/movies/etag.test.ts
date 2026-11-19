import { describe, expect, it } from "vitest";
import { InvalidIfMatchError, movieEtag, parseIfMatch } from "./etag.ts";

describe("movieEtag", () => {
  it("is a strong, quoted tag of the version", () => {
    expect(movieEtag(1)).toBe('"1"');
    expect(movieEtag(42)).toBe('"42"');
  });

  it("round-trips through parseIfMatch", () => {
    expect(parseIfMatch(movieEtag(7))).toEqual({ kind: "versions", versions: [7] });
  });
});

describe("parseIfMatch", () => {
  it("returns null when the header is absent (no precondition)", () => {
    expect(parseIfMatch(undefined)).toBeNull();
  });

  it('parses "*" as any existing representation', () => {
    expect(parseIfMatch("*")).toEqual({ kind: "any" });
    expect(parseIfMatch("  *  ")).toEqual({ kind: "any" });
  });

  it("parses a list of strong tags", () => {
    expect(parseIfMatch('"3", "4" ,"5"')).toEqual({ kind: "versions", versions: [3, 4, 5] });
  });

  it.each([
    ["weak tag (never matches under strong comparison)", 'W/"3"'],
    ["strong tag we never issued", '"abc"'],
    ["version longer than int4", '"12345678901"'],
  ])("accepts a %s but yields no comparable version", (_name, header) => {
    expect(parseIfMatch(header)).toEqual({ kind: "versions", versions: [] });
  });

  it("keeps only comparable versions from a mixed list", () => {
    expect(parseIfMatch('W/"2", "3", "x"')).toEqual({ kind: "versions", versions: [3] });
  });

  it.each([
    ["empty", ""],
    ["unquoted", "3"],
    ["missing closing quote", '"3'],
    ["star inside a list", '*, "3"'],
    ["empty list item", '"3",,"4"'],
    ["quote inside the tag", '"3"4"'],
  ])("rejects a malformed header (%s)", (_name, header) => {
    expect(() => parseIfMatch(header)).toThrow(InvalidIfMatchError);
  });
});
