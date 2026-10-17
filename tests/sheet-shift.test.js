import { describe, expect, it } from "vitest";
import {
  shiftCells,
  shiftFormulaReferences,
  shiftMerges,
  shiftOverrides,
  shiftRef
} from "../src/sheet/shift.js";

describe("shiftRef", () => {
  it("shifts rows on insert, honouring absolute markers", () => {
    const shift = { mode: "insert", axis: "row", index: 2, count: 1 };
    expect(shiftRef(shift, { col: 1, row: 1, absCol: false, absRow: false })).toEqual({
      col: 1,
      row: 1,
      absCol: false,
      absRow: false
    });
    expect(shiftRef(shift, { col: 1, row: 5, absCol: false, absRow: false }).row).toBe(6);
    // Absolute refs move too: the position changed, not a copy offset.
    expect(shiftRef(shift, { col: 1, row: 5, absCol: false, absRow: true }).row).toBe(6);
  });

  it("shifts columns on insert", () => {
    const shift = { mode: "insert", axis: "column", index: 0, count: 2 };
    // Columns are 1-based in a CellRef: A is 1, so A moves to C.
    expect(shiftRef(shift, { col: 1, row: 1, absCol: true, absRow: false }).col).toBe(3);
  });

  it("returns null for deleted rows", () => {
    const shift = { mode: "delete", axis: "row", index: 3, count: 2 };
    // Deletes 1-based rows 4 and 5.
    expect(shiftRef(shift, { col: 1, row: 4, absCol: false, absRow: false })).toBeNull();
    expect(shiftRef(shift, { col: 1, row: 5, absCol: false, absRow: false })).toBeNull();
    expect(shiftRef(shift, { col: 1, row: 3, absCol: false, absRow: false }).row).toBe(3);
    expect(shiftRef(shift, { col: 1, row: 7, absCol: false, absRow: false }).row).toBe(5);
  });
});

describe("shiftFormulaReferences", () => {
  it("rewrites references, preserving absolute markers and spacing", () => {
    const shift = { mode: "insert", axis: "row", index: 0, count: 1 };
    expect(shiftFormulaReferences("=SUM(A1:A3)", shift)).toBe("=SUM(A2:A4)");
    expect(shiftFormulaReferences("=SUM($A$1:$A3) + $B$4", shift)).toBe("=SUM($A$2:$A4) + $B$5");
    expect(shiftFormulaReferences("=A1 * 2 + B5", shift)).toBe("=A2 * 2 + B6");
  });

  it("keeps strings, function names and whitespace untouched", () => {
    const shift = { mode: "insert", axis: "row", index: 0, count: 1 };
    expect(shiftFormulaReferences('=CONCAT("A1", A1)', shift)).toBe('=CONCAT("A1", A2)');
    expect(shiftFormulaReferences("=SUM( A1 , A2 )", shift)).toBe("=SUM( A2 , A3 )");
  });

  it("produces #REF! for deleted targets", () => {
    const shift = { mode: "delete", axis: "column", index: 1, count: 1 };
    expect(shiftFormulaReferences("=SUM(A1:B1)", shift)).toBe("=SUM(A1:#REF!)");
    expect(shiftFormulaReferences("=C1", shift)).toBe("=B1");
  });

  it("returns malformed formulas unchanged", () => {
    const shift = { mode: "insert", axis: "row", index: 0, count: 1 };
    expect(shiftFormulaReferences("=SUM(", shift)).toBe("=SUM(");
  });
});

describe("shiftCells", () => {
  it("moves stored cells and their formulas", () => {
    const shift = { mode: "insert", axis: "row", index: 0, count: 1 };
    const cells = {
      "0,0": { value: 1 },
      "1,1": { formula: "=A1" }
    };
    expect(shiftCells(cells, shift)).toEqual({
      "0,1": { value: 1 },
      "1,2": { formula: "=A2" }
    });
  });

  it("drops cells on deleted lines", () => {
    const shift = { mode: "delete", axis: "row", index: 0, count: 1 };
    const cells = { "0,0": { value: "gone" }, "0,1": { value: "stays" } };
    expect(shiftCells(cells, shift)).toEqual({ "0,0": { value: "stays" } });
  });
});

describe("shiftOverrides", () => {
  it("moves and drops overrides", () => {
    const insert = { mode: "insert", axis: "column", index: 0, count: 1 };
    expect(shiftOverrides({ 0: { width: 10 }, 2: { width: 30 } }, insert)).toEqual({
      1: { width: 10 },
      3: { width: 30 }
    });
    const remove = { mode: "delete", axis: "column", index: 0, count: 1 };
    expect(shiftOverrides({ 0: { width: 10 }, 1: { width: 20 } }, remove)).toEqual({
      0: { width: 20 }
    });
  });
});

describe("shiftMerges", () => {
  it("moves merges below an inserted row", () => {
    const shift = { mode: "insert", axis: "row", index: 1, count: 2 };
    const merges = [{ start: { col: 0, row: 1 }, end: { col: 1, row: 1 } }];
    expect(shiftMerges(merges, shift)).toEqual([
      { start: { col: 0, row: 3 }, end: { col: 1, row: 3 } }
    ]);
  });

  it("leaves merges above an inserted row alone", () => {
    const shift = { mode: "insert", axis: "row", index: 3, count: 1 };
    const merges = [{ start: { col: 0, row: 1 }, end: { col: 1, row: 1 } }];
    expect(shiftMerges(merges, shift)).toEqual(merges);
  });

  it("drops fully deleted merges and clamps straddling ones", () => {
    const shift = { mode: "delete", axis: "row", index: 1, count: 1 };
    expect(shiftMerges([{ start: { col: 0, row: 1 }, end: { col: 1, row: 1 } }], shift)).toEqual([]);

    const spanning = [{ start: { col: 0, row: 0 }, end: { col: 0, row: 2 } }];
    expect(shiftMerges(spanning, shift)).toEqual([
      { start: { col: 0, row: 0 }, end: { col: 0, row: 1 } }
    ]);

    const below = [{ start: { col: 0, row: 3 }, end: { col: 0, row: 4 } }];
    expect(shiftMerges(below, shift)).toEqual([
      { start: { col: 0, row: 2 }, end: { col: 0, row: 3 } }
    ]);
  });
});
