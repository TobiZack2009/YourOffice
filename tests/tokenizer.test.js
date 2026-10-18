import { describe, expect, it } from "vitest";
import { tokenize, FormulaSyntaxError } from "../src/sheet/tokenizer.js";

/** Strip positions/eof for concise assertions. */
const shape = (input) =>
  tokenize(input)
    .filter((t) => t.type !== "eof")
    .map((t) => [t.type, t.value]);

describe("tokenize", () => {
  it("ignores a leading equals sign", () => {
    expect(shape("=1+2")).toEqual(shape("1+2"));
  });

  it("tokenizes numbers including decimals and exponents", () => {
    expect(shape("1 2.5 .5 1e3 2.5E-2")).toEqual([
      ["number", 1],
      ["number", 2.5],
      ["number", 0.5],
      ["number", 1000],
      ["number", 0.025]
    ]);
  });

  it("tokenizes strings with doubled-quote escapes", () => {
    expect(shape('"hello"')).toEqual([["string", "hello"]]);
    expect(shape('"say ""hi"""')).toEqual([["string", 'say "hi"']]);
    expect(shape('""')).toEqual([["string", ""]]);
  });

  it("rejects unterminated strings", () => {
    expect(() => tokenize('"oops')).toThrow(FormulaSyntaxError);
  });

  it("tokenizes booleans", () => {
    expect(shape("TRUE FALSE")).toEqual([
      ["boolean", true],
      ["boolean", false]
    ]);
  });

  it("tokenizes error literals", () => {
    expect(shape("#REF!")).toEqual([["error", "#REF!"]]);
    expect(shape("#DIV/0!")).toEqual([["error", "#DIV/0!"]]);
    expect(() => tokenize("#NOPE!")).toThrow(FormulaSyntaxError);
  });

  it("tokenizes words as references or names", () => {
    expect(shape("A1 $B$2 SUM foo_bar")).toEqual([
      ["word", "A1"],
      ["word", "$B$2"],
      ["word", "SUM"],
      ["word", "foo_bar"]
    ]);
  });

  it("tokenizes operators, punctuation, and ranges", () => {
    expect(shape("A1:B2")).toEqual([
      ["word", "A1"],
      ["colon", ":"],
      ["word", "B2"]
    ]);
    expect(shape("(1+2)*3")).toEqual([
      ["lparen", "("],
      ["number", 1],
      ["op", "+"],
      ["number", 2],
      ["rparen", ")"],
      ["op", "*"],
      ["number", 3]
    ]);
  });

  it("prefers the longest operator match", () => {
    expect(shape("1<=2")).toEqual([
      ["number", 1],
      ["op", "<="],
      ["number", 2]
    ]);
    expect(shape("1<>2")).toEqual([
      ["number", 1],
      ["op", "<>"],
      ["number", 2]
    ]);
    expect(shape("1>=2")).toEqual([
      ["number", 1],
      ["op", ">="],
      ["number", 2]
    ]);
  });

  it("records source positions", () => {
    const tokens = tokenize("1 + A1");
    const ref = tokens.find((t) => t.value === "A1");
    expect(ref?.pos).toBe(4);
  });

  it("rejects unexpected characters", () => {
    expect(() => tokenize("1 @ 2")).toThrow(FormulaSyntaxError);
  });

  it("always ends with eof", () => {
    expect(tokenize("").at(-1)?.type).toBe("eof");
  });
});

describe("tokenize — names, paths and offsets", () => {
  it("gives every token an end offset", () => {
    const tokens = tokenize("=SUM(A1, 2)").filter((t) => t.type !== "eof");
    expect(tokens.map((t) => [t.pos, t.end])).toEqual([
      [0, 3], [3, 4], [4, 6], [6, 7], [8, 9], [9, 10]
    ]);
  });

  it("tokenizes bang-separated paths", () => {
    expect(shape("Expenses!B2")).toEqual([["word", "Expenses"], ["bang", "!"], ["word", "B2"]]);
  });

  it("tokenizes quoted names with doubled quote escapes", () => {
    expect(shape("'Q3 Budget'!Notes")).toEqual([["qname", "Q3 Budget"], ["bang", "!"], ["word", "Notes"]]);
    expect(shape("'It''s'")).toEqual([["qname", "It's"]]);
  });

  it("rejects unterminated and empty quoted names", () => {
    expect(() => tokenize("'abc")).toThrow(FormulaSyntaxError);
    expect(() => tokenize("''")).toThrow(FormulaSyntaxError);
  });

  it("still reads error literals that end in a bang", () => {
    expect(shape("#REF!+1")).toEqual([["error", "#REF!"], ["op", "+"], ["number", 1]]);
  });
});
