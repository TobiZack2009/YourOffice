import { describe, expect, it } from "vitest";
import {
  a1ToPosition,
  cellKey,
  columnLabel,
  createSheetContent,
  createTable,
  ensureSheetContent,
  findMerge,
  getCell,
  isMergeAnchor,
  parseCellKey,
  positionToA1,
  setCell,
  validateSheetContent,
  validateTable
} from "../src/calc/model.js";
import { CommandError } from "../src/core/errors.js";

describe("sheet content", () => {
  it("starts empty", () => {
    expect(createSheetContent()).toEqual({ tables: {}, tableOrder: [] });
  });

  it("validates a well-formed content object", () => {
    const table = createTable();
    const content = { tables: { [table.id]: table }, tableOrder: [table.id] };
    expect(validateSheetContent(content)).toEqual([]);
  });

  it("reports unreachable and dangling tables", () => {
    const table = createTable();
    const dangling = validateSheetContent({ tables: { [table.id]: table }, tableOrder: [] });
    expect(dangling.some((message) => message.includes("not reachable"))).toBe(true);
    const missing = validateSheetContent({ tables: {}, tableOrder: ["table_x"] });
    expect(missing.some((message) => message.includes("missing table"))).toBe(true);
  });

  it("initialises content on a page envelope", () => {
    const page = /** @type {any} */ ({ id: "sheet_1", type: "sheet" });
    const content = ensureSheetContent(page);
    expect(content).toEqual({ tables: {}, tableOrder: [] });
    expect(page.content).toBe(content);
  });
});

describe("createTable", () => {
  it("applies defaults", () => {
    const table = createTable();
    expect(table.id.startsWith("table_")).toBe(true);
    expect(table.columnCount).toBe(8);
    expect(table.rowCount).toBe(20);
    expect(table.cells).toEqual({});
    expect(table.merges).toEqual([]);
  });

  it("accepts overrides and rejects invalid values", () => {
    const table = createTable({ name: "Budget", columnCount: 3, rowCount: 2 });
    expect(table.name).toBe("Budget");
    expect(() => createTable({ columnCount: 0 })).toThrow(CommandError);
    expect(() => createTable({ rowHeight: -1 })).toThrow(CommandError);
  });
});

describe("cell addressing", () => {
  it("round-trips sparse keys", () => {
    expect(cellKey(2, 5)).toBe("2,5");
    expect(parseCellKey("2,5")).toEqual({ col: 2, row: 5 });
    expect(parseCellKey("nope")).toBeNull();
  });

  it("converts between 0-based positions and A1", () => {
    expect(positionToA1(0, 0)).toBe("A1");
    expect(positionToA1(2, 9)).toBe("C10");
    expect(a1ToPosition("C10")).toEqual({ col: 2, row: 9 });
    expect(a1ToPosition("bogus")).toBeNull();
  });

  it("labels columns", () => {
    expect(columnLabel(0)).toBe("A");
    expect(columnLabel(25)).toBe("Z");
    expect(columnLabel(26)).toBe("AA");
  });
});

describe("sparse cells", () => {
  it("sets, reads and clears cells", () => {
    const table = createTable();
    setCell(table, 1, 1, { value: 42 });
    expect(getCell(table, 1, 1)).toEqual({ value: 42 });
    expect(Object.keys(table.cells)).toEqual(["1,1"]);
    setCell(table, 1, 1, null);
    expect(getCell(table, 1, 1)).toBeUndefined();
    expect(table.cells).toEqual({});
  });
});

describe("validation", () => {
  it("rejects cells carrying both formula and value", () => {
    const table = createTable();
    setCell(table, 0, 0, { value: 1, formula: "=A1" });
    const errors = validateTable(table);
    expect(errors.some((message) => message.includes("both formula and value"))).toBe(true);
  });

  it("rejects formulas without a leading equals", () => {
    const table = createTable();
    setCell(table, 0, 0, { formula: "SUM(A1:A2)" });
    expect(validateTable(table).some((message) => message.includes('start with "="'))).toBe(true);
  });

  it("rejects cells outside the table bounds", () => {
    const table = createTable({ columnCount: 2, rowCount: 2 });
    setCell(table, 5, 0, { value: 1 });
    expect(validateTable(table).some((message) => message.includes("outside the table bounds"))).toBe(
      true
    );
  });

  it("rejects unnormalised and out-of-range merges", () => {
    const table = createTable({ columnCount: 3, rowCount: 3, merges: [] });
    table.merges.push({ start: { col: 2, row: 0 }, end: { col: 0, row: 0 } });
    expect(validateTable(table).some((message) => message.includes("normalised"))).toBe(true);
    table.merges = [{ start: { col: 0, row: 0 }, end: { col: 9, row: 0 } }];
    expect(validateTable(table).some((message) => message.includes("outside"))).toBe(true);
  });

  it("rejects invalid overrides", () => {
    const table = createTable({ rowCount: 2, columnCount: 2 });
    table.rowOverrides = { 5: { height: 30 } };
    table.columnOverrides = { 0: { width: -2 } };
    const errors = validateTable(table);
    expect(errors.some((message) => message.includes("rowOverrides"))).toBe(true);
    expect(errors.some((message) => message.includes("columnOverrides"))).toBe(true);
  });
});

describe("merges", () => {
  it("finds the covering merge and its anchor", () => {
    const table = createTable({ columnCount: 4, rowCount: 4 });
    table.merges = [{ start: { col: 1, row: 1 }, end: { col: 3, row: 2 } }];
    expect(findMerge(table, 2, 2)).toEqual(table.merges[0]);
    expect(findMerge(table, 0, 0)).toBeUndefined();
    expect(isMergeAnchor(table, 1, 1)).toBe(true);
    expect(isMergeAnchor(table, 2, 2)).toBe(false);
  });
});
