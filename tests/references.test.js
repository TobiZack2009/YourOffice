import { describe, expect, it } from "vitest";
import {
  columnToIndex,
  indexToColumn,
  parseA1,
  formatA1,
  refKey,
  keyToRef,
  normaliseRange,
  rangeContains,
  sameCell
} from "../src/calc/references.js";

describe("column exercise", () => {
  it("converts letters to 1-based indices", () => {
    expect(columnToIndex("A")).toBe(1);
    expect(columnToIndex("Z")).toBe(26);
    expect(columnToIndex("AA")).toBe(27);
    expect(columnToIndex("AZ")).toBe(52);
    expect(columnToIndex("BA")).toBe(53);
    expect(columnToIndex("XFD")).toBe(16384);
  });

  it("round-trips indices and letters", () => {
    for (const index of [1, 2, 26, 27, 52, 53, 702, 703, 16384]) {
      expect(columnToIndex(indexToColumn(index))).toBe(index);
    }
  });

  it("rejects invalid letters and out-of-range columns", () => {
    expect(columnToIndex("")).toBeNull();
    expect(columnToIndex("AAAA")).toBeNull();
    expect(columnToIndex("1")).toBeNull();
    expect(columnToIndex("XFE")).toBeNull();
  });
});

describe("parseA1", () => {
  it("parses relative references", () => {
    expect(parseA1("A1")).toEqual({ col: 1, row: 1, absCol: false, absRow: false });
    expect(parseA1("b12")).toEqual({ col: 2, row: 12, absCol: false, absRow: false });
  });

  it("parses absolute and mixed references", () => {
    expect(parseA1("$A$1")).toEqual({ col: 1, row: 1, absCol: true, absRow: true });
    expect(parseA1("$A1")).toEqual({ col: 1, row: 1, absCol: true, absRow: false });
    expect(parseA1("A$1")).toEqual({ col: 1, row: 1, absCol: false, absRow: true });
  });

  it("rejects non-references", () => {
    for (const bad of ["", "A", "1", "SUM", "A0", "$", "A1B", "1A", "AAAA1", "A1048577"]) {
      expect(parseA1(bad), bad).toBeNull();
    }
  });
});

describe("formatA1", () => {
  it("formats absolute and mixed markers", () => {
    expect(formatA1({ col: 1, row: 1 })).toBe("A1");
    expect(formatA1({ col: 1, row: 1, absCol: true, absRow: true })).toBe("$A$1");
    expect(formatA1({ col: 28, row: 100, absRow: true })).toBe("AB$100");
  });

  it("round-trips parsed references", () => {
    for (const text of ["A1", "$A$1", "B$7", "$XFD1048576"]) {
      expect(formatA1(parseA1(text))).toBe(text);
    }
  });
});

describe("keys and ranges", () => {
  it("keys ignore absolute markers", () => {
    expect(refKey({ col: 3, row: 12 })).toBe("3,12");
    expect(refKey(parseA1("$C$12"))).toBe("3,12");
    expect(keyToRef("3,12")).toEqual({ col: 3, row: 12 });
    expect(keyToRef("nope")).toBeNull();
  });

  it("sameCell compares positions only", () => {
    expect(sameCell(parseA1("A1"), parseA1("$A$1"))).toBe(true);
    expect(sameCell(parseA1("A1"), parseA1("A2"))).toBe(false);
  });

  it("normalises ranges regardless of corner order", () => {
    const range = normaliseRange(parseA1("C3"), parseA1("A1"));
    expect(range.start).toEqual({ col: 1, row: 1 });
    expect(range.end).toEqual({ col: 3, row: 3 });
  });

  it("tests range membership inclusively", () => {
    const { start, end } = normaliseRange(parseA1("A1"), parseA1("B2"));
    expect(rangeContains(parseA1("A1"), start, end)).toBe(true);
    expect(rangeContains(parseA1("B2"), start, end)).toBe(true);
    expect(rangeContains(parseA1("C1"), start, end)).toBe(false);
    expect(rangeContains(parseA1("A3"), start, end)).toBe(false);
  });
});
