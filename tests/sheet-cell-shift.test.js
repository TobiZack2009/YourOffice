import { describe, expect, it } from "vitest";
import {
  mergeBlocksShift,
  retargetMovedReferences,
  shiftPosition,
  shiftRegionCells,
  shiftRegionReferences
} from "../src/sheet/cell-shift.js";

/** Insert 2 cells shifting down at row 1 (0-based), in columns 0..1. */
const insertDown = { mode: "insert", axis: "row", index: 1, count: 2, lo: 0, hi: 1 };
/** Delete rows 1..2 shifting up, in column 0 only. */
const deleteUp = { mode: "delete", axis: "row", index: 1, count: 2, lo: 0, hi: 0 };
/** Insert 1 cell shifting right at column 1, in row 0. */
const insertRight = { mode: "insert", axis: "column", index: 1, count: 1, lo: 0, hi: 0 };
/** Delete column 1 shifting left, in rows 0..1. */
const deleteLeft = { mode: "delete", axis: "column", index: 1, count: 1, lo: 0, hi: 1 };

describe("shiftPosition", () => {
  it("slides cells at or past the gap and leaves the rest", () => {
    expect(shiftPosition({ col: 0, row: 0 }, insertDown)).toEqual({ col: 0, row: 0 });
    expect(shiftPosition({ col: 1, row: 1 }, insertDown)).toEqual({ col: 1, row: 3 });
    expect(shiftPosition({ col: 2, row: 1 }, insertDown)).toEqual({ col: 2, row: 1 }); // outside the band
  });

  it("closes a deleted gap and drops what was inside it", () => {
    expect(shiftPosition({ col: 0, row: 1 }, deleteUp)).toBeNull();
    expect(shiftPosition({ col: 0, row: 2 }, deleteUp)).toBeNull();
    expect(shiftPosition({ col: 0, row: 3 }, deleteUp)).toEqual({ col: 0, row: 1 });
    expect(shiftPosition({ col: 1, row: 3 }, deleteUp)).toEqual({ col: 1, row: 3 });
  });

  it("works along columns", () => {
    expect(shiftPosition({ col: 1, row: 0 }, insertRight)).toEqual({ col: 2, row: 0 });
    expect(shiftPosition({ col: 1, row: 1 }, insertRight)).toEqual({ col: 1, row: 1 });
    expect(shiftPosition({ col: 2, row: 1 }, deleteLeft)).toEqual({ col: 1, row: 1 });
  });
});

describe("shiftRegionReferences", () => {
  it("makes a lone reference follow its cell", () => {
    expect(shiftRegionReferences("=A2+B3", insertDown)).toBe("=A4+B5");
    expect(shiftRegionReferences("=A1+C2", insertDown)).toBe("=A1+C2");
  });

  it("keeps spacing, strings and absolute markers", () => {
    expect(shiftRegionReferences('= $A$2 + "A2"', insertDown)).toBe('= $A$4 + "A2"');
  });

  it("shifts a range only when it sits wholly inside the band", () => {
    expect(shiftRegionReferences("=SUM(A2:B3)", insertDown)).toBe("=SUM(A4:B5)");
    // Straddles the band edge (column C is outside): left alone.
    expect(shiftRegionReferences("=SUM(A2:C3)", insertDown)).toBe("=SUM(A2:C3)");
  });

  it("grows a range that has the gap inside it", () => {
    expect(shiftRegionReferences("=SUM(A1:B3)", insertDown)).toBe("=SUM(A1:B5)");
  });

  it("turns references to deleted cells into #REF!", () => {
    expect(shiftRegionReferences("=A2+A4", deleteUp)).toBe("=#REF!+A2");
    expect(shiftRegionReferences("=SUM(A2:A3)", deleteUp)).toBe("=SUM(#REF!)");
  });

  it("trims a range when part of it is deleted", () => {
    expect(shiftRegionReferences("=SUM(A1:A4)", deleteUp)).toBe("=SUM(A1:A2)");
  });

  it("returns unparseable text unchanged", () => {
    expect(shiftRegionReferences('="open', insertDown)).toBe('="open');
  });
});

describe("shiftRegionCells", () => {
  it("slides cells, drops deleted ones, and retargets every formula", () => {
    const cells = {
      "0,0": { value: 1 },
      "0,1": { value: 2 },
      "0,3": { formula: "=A2" },
      "2,0": { formula: "=A2" }
    };
    const shifted = shiftRegionCells(cells, insertDown);
    expect(shifted).toEqual({
      "0,0": { value: 1 },
      "0,3": { value: 2 },
      "0,5": { formula: "=A4" },
      "2,0": { formula: "=A4" }
    });
    expect(cells["0,1"]).toEqual({ value: 2 }); // the input is untouched

    const trimmed = shiftRegionCells(cells, deleteUp);
    expect(trimmed["0,1"]).toEqual({ formula: "=#REF!" });
    expect(trimmed["0,0"]).toEqual({ value: 1 });
    expect(trimmed["0,2"]).toBeUndefined();
  });
});

describe("mergeBlocksShift", () => {
  it("flags merges that touch the band at or beyond the gap", () => {
    const merge = (/** @type {number[]} */ [c1, r1, c2, r2]) => ({
      start: { col: c1, row: r1 },
      end: { col: c2, row: r2 }
    });
    expect(mergeBlocksShift(merge([0, 3, 1, 3]), insertDown)).toBe(true);
    expect(mergeBlocksShift(merge([0, 0, 1, 0]), insertDown)).toBe(false); // above the gap
    expect(mergeBlocksShift(merge([2, 3, 3, 3]), insertDown)).toBe(false); // other columns
  });
});

describe("retargetMovedReferences", () => {
  const block = { start: { col: 0, row: 0 }, end: { col: 1, row: 1 } }; // A1:B2

  it("moves a lone reference into the block by the offset, keeping $ markers and spacing", () => {
    expect(retargetMovedReferences("=A1 + $B$2", block, 3, 5)).toBe("=D6 + $E$7");
    expect(retargetMovedReferences("=C1+A3", block, 3, 5)).toBe("=C1+A3");
  });

  it("moves a range only when both ends are inside the block", () => {
    expect(retargetMovedReferences("=SUM(A1:B2)", block, 0, 4)).toBe("=SUM(A5:B6)");
    expect(retargetMovedReferences("=SUM(A1:B5)", block, 0, 4)).toBe("=SUM(A1:B5)");
  });

  it("sends a target pushed off the sheet to #REF! and tolerates bad text", () => {
    expect(retargetMovedReferences("=A1", block, -1, 0)).toBe("=#REF!");
    expect(retargetMovedReferences("=\"unterminated", block, 1, 1)).toBe("=\"unterminated");
  });
});
