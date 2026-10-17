import { describe, expect, it } from "vitest";
import { offsetCell, offsetFormulaReferences, tileSourceFor } from "../src/sheet/fill.js";

describe("offsetFormulaReferences", () => {
  it("moves relative references by the offset", () => {
    expect(offsetFormulaReferences("=A1*2", 0, 1)).toBe("=A2*2");
    expect(offsetFormulaReferences("=A1+B1", 2, 0)).toBe("=C1+D1");
    expect(offsetFormulaReferences("=B3", -1, -2)).toBe("=A1");
  });

  it("keeps $-pinned axes in place", () => {
    expect(offsetFormulaReferences("=$A1", 1, 1)).toBe("=$A2");
    expect(offsetFormulaReferences("=A$1", 1, 1)).toBe("=B$1");
    expect(offsetFormulaReferences("=$A$1+B2", 3, 3)).toBe("=$A$1+E5");
  });

  it("moves both ends of a range and preserves spacing and strings", () => {
    expect(offsetFormulaReferences("=SUM( A1:B2 ) & \"A1\"", 0, 1)).toBe("=SUM( A2:B3 ) & \"A1\"");
  });

  it("turns references pushed off the sheet into #REF!", () => {
    expect(offsetFormulaReferences("=A1", -1, 0)).toBe("=#REF!");
    expect(offsetFormulaReferences("=B2", 0, -2)).toBe("=#REF!");
  });

  it("returns the input unchanged for a zero offset or malformed text", () => {
    expect(offsetFormulaReferences("=A1", 0, 0)).toBe("=A1");
    expect(offsetFormulaReferences('=A1&"open', 1, 1)).toBe('=A1&"open');
  });
});

describe("offsetCell", () => {
  it("offsets formulas and copies literals", () => {
    expect(offsetCell({ formula: "=A1" }, 1, 1)).toEqual({ formula: "=B2" });
    const literal = { value: 3 };
    const copy = offsetCell(literal, 1, 1);
    expect(copy).toEqual({ value: 3 });
    expect(copy).not.toBe(literal);
  });
});

describe("tileSourceFor", () => {
  const source = { start: { col: 1, row: 1 }, end: { col: 2, row: 2 } };

  it("maps positions inside the source to themselves", () => {
    expect(tileSourceFor(source, { col: 2, row: 1 })).toEqual({ col: 2, row: 1 });
  });

  it("repeats the pattern forwards and backwards", () => {
    expect(tileSourceFor(source, { col: 3, row: 3 })).toEqual({ col: 1, row: 1 });
    expect(tileSourceFor(source, { col: 4, row: 2 })).toEqual({ col: 2, row: 2 });
    expect(tileSourceFor(source, { col: 0, row: 0 })).toEqual({ col: 2, row: 2 });
  });
});
