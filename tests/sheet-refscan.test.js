import { describe, expect, it } from "vitest";
import { analyzeFormula, rewriteFormula } from "../src/sheet/refscan.js";
import { shiftFormulaReferences } from "../src/sheet/shift.js";
import { offsetFormulaReferences } from "../src/sheet/fill.js";
import { shiftRegionReferences, retargetMovedReferences } from "../src/sheet/cell-shift.js";

const kinds = (text) =>
  analyzeFormula(text).units.map((u) => [u.kind, u.segments.join("!"), u.first ? `${u.first.col},${u.first.row}` : null]);

describe("scanUnits", () => {
  it("finds plain, ranged and qualified addresses", () => {
    expect(kinds("=A1+B2:C3+Expenses!D4")).toEqual([
      ["address", "", "1,1"],
      ["address", "", "2,2"],
      ["address", "Expenses", "4,4"]
    ]);
  });

  it("finds names and paths, ignoring function names", () => {
    expect(kinds("=SUM(Costs) + Plan!Notes + 'Q3 Budget'!Tbl!A1")).toEqual([
      ["name", "Costs", null],
      ["name", "Plan!Notes", null],
      ["address", "Q3 Budget!Tbl", "1,1"]
    ]);
  });

  it("returns null for text that does not tokenize", () => {
    expect(analyzeFormula('="open')).toBeNull();
  });
});

describe("rewriteFormula", () => {
  it("leaves the original text alone when nothing changes", () => {
    expect(rewriteFormula("A1 + 1", () => [])).toBe("A1 + 1");
    expect(rewriteFormula('="open', () => [{ from: 0, to: 0, text: "x" }])).toBe('="open');
  });

  it("splices edits and keeps spacing and strings", () => {
    const out = rewriteFormula('=IF(  A1 > 0 , "A1" , B1 )', ({ units }) =>
      units.map((u) => ({ from: u.from, to: u.to, text: "Z9" }))
    );
    expect(out).toBe('=IF(  Z9 > 0 , "A1" , Z9 )');
  });
});

describe("rewrites only touch references that point at the edited table", () => {
  const insertRow = { mode: "insert", axis: "row", index: 0, count: 1 };

  it("shift: qualified references are skipped unless targeted", () => {
    expect(shiftFormulaReferences("=A1+Other!A1", insertRow)).toBe("=A2+Other!A1");
    const target = (segments) => segments.join("!") === "Other";
    expect(shiftFormulaReferences("=A1+Other!A1", insertRow, { target })).toBe("=A1+Other!A2");
    expect(shiftFormulaReferences("=Other!A1:B2", insertRow, { target })).toBe("=Other!A2:B3");
  });

  it("shift: deleting a qualified target replaces the whole qualified reference with #REF!", () => {
    const target = (segments) => segments[0] === "Other";
    const del = { mode: "delete", axis: "row", index: 0, count: 1 };
    expect(shiftFormulaReferences("=Other!A1+1", del, { target })).toBe("=#REF!+1");
  });

  it("fill: relative references move whether or not they are qualified", () => {
    expect(offsetFormulaReferences("=A1+Other!B2", 1, 1)).toBe("=B2+Other!C3");
    expect(offsetFormulaReferences("=Other!$B$2", 1, 1)).toBe("=Other!$B$2");
  });

  it("region shift and move retarget qualified references on request", () => {
    const shift = { mode: "insert", axis: "row", index: 0, count: 1, lo: 0, hi: 5 };
    const target = (segments) => segments[0] === "Other";
    expect(shiftRegionReferences("=A1+Other!A1", shift, { target })).toBe("=A1+Other!A2");
    const block = { start: { col: 0, row: 0 }, end: { col: 0, row: 0 } };
    expect(retargetMovedReferences("=Other!A1", block, 0, 2, { target })).toBe("=Other!A3");
    expect(retargetMovedReferences("=Other!A1", block, 0, 2)).toBe("=Other!A1");
  });
});
